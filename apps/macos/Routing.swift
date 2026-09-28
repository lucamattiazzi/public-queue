import AppKit

enum DestinationKind: String, Codable { case local, cloud }
struct ModelDestination: Codable {
    var id: String
    var name: String
    var model: String
    var runtimeUrl: String
    var runtimeKey: String?
    var kind: DestinationKind
    var cloudApproved: Bool
}
struct ModelRouting: Codable {
    var destinations: [ModelDestination]
    var profiles: [String: String]
    static func load(_ config: [String: Any]) -> ModelRouting {
        if let raw = config["routing"], let bytes = try? JSONSerialization.data(withJSONObject: raw),
           let routing = try? JSONDecoder().decode(ModelRouting.self, from: bytes) { return routing }
        let destinations = (config["models"] as? [String] ?? []).enumerated().map { index, model in
            ModelDestination(id: "primary-\(index)", name: model, model: model, runtimeUrl: config["runtimeUrl"] as? String ?? "", runtimeKey: config["runtimeKey"] as? String, kind: .local, cloudApproved: false)
        }
        return ModelRouting(destinations: destinations, profiles: destinations.first.map { ["fast": $0.id, "quality": $0.id] } ?? [:])
    }
}

final class RoutingEditor: NSObject {
    let window: NSWindow
    var routing: ModelRouting
    var selected = 0
    let destination = NSPopUpButton()
    let name = NSTextField(string: "")
    let model = NSTextField(string: "")
    let endpoint = NSTextField(string: "")
    let secret = NSSecureTextField(string: "")
    let kind = NSPopUpButton()
    let approval = NSButton(checkboxWithTitle: "Consento invio dei prompt e costi di questo provider cloud", target: nil, action: nil)
    let message = NSTextField(wrappingLabelWithString: "")
    let save = NSButton(title: "Salva e applica", target: nil, action: nil)
    var selectors: [String: NSPopUpButton] = [:]
    let onSave: (ModelRouting, @escaping (String?) -> Void) -> Void

    init(routing: ModelRouting, onSave: @escaping (ModelRouting, @escaping (String?) -> Void) -> Void) {
        self.routing = routing; self.onSave = onSave
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 735), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Modelli e profili"; window.isReleasedWhenClosed = false; window.center()
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 13
        stack.translatesAutoresizingMaskIntoConstraints = false; window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
        let title = NSTextField(labelWithString: "Il modello giusto per ogni job."); title.font = .systemFont(ofSize: 24, weight: .bold); stack.addArrangedSubview(title)
        let intro = NSTextField(wrappingLabelWithString: "Registra i tuoi modelli, poi assegna i profili. Il frontend può chiedere un profilo oppure il nome preciso di un modello. Nessun fallback automatico.")
        intro.textColor = .secondaryLabelColor; stack.addArrangedSubview(intro); intro.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        destination.target = self; destination.action = #selector(selectDestination)
        let add = NSButton(title: "+ Aggiungi", target: self, action: #selector(addDestination))
        let remove = NSButton(title: "Rimuovi", target: self, action: #selector(removeDestination))
        let row = NSStackView(views: [destination, add, remove]); row.spacing = 8; stack.addArrangedSubview(row)
        destination.widthAnchor.constraint(equalToConstant: 355).isActive = true
        kind.addItems(withTitles: ["Locale / rete privata", "Cloud"]); kind.target = self; kind.action = #selector(kindChanged)
        model.placeholderString = "Nome esatto richiesto dal runtime"
        endpoint.placeholderString = "http://127.0.0.1:11434/v1 oppure https://provider/v1"
        secret.placeholderString = "Facoltativa — salvata solo su questo Mac"
        let grid = NSGridView(views: [
            [NSTextField(labelWithString: "Nome destinazione"), name],
            [NSTextField(labelWithString: "Modello"), model],
            [NSTextField(labelWithString: "Endpoint"), endpoint],
            [NSTextField(labelWithString: "Tipo"), kind],
            [NSTextField(labelWithString: "Chiave API"), secret],
        ])
        grid.rowSpacing = 10; grid.columnSpacing = 18; grid.xPlacement = .fill; grid.column(at: 0).width = 135
        stack.addArrangedSubview(grid); grid.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.addArrangedSubview(approval)
        let profilesTitle = NSTextField(labelWithString: "Profili richiesti dal frontend"); profilesTitle.font = .systemFont(ofSize: 16, weight: .semibold); stack.addArrangedSubview(profilesTitle)
        var rows: [[NSView]] = []
        for (key, text) in [("fast", "fast · estrazione e compiti rapidi"), ("quality", "quality · generazione e ragionamento"), ("vision", "vision · modello dedicato*"), ("cloud", "cloud · provider esterno")] {
            let popup = NSPopUpButton(); selectors[key] = popup
            rows.append([NSTextField(labelWithString: text), popup])
        }
        let profileGrid = NSGridView(views: rows); profileGrid.rowSpacing = 10; profileGrid.columnSpacing = 18; profileGrid.xPlacement = .fill
        stack.addArrangedSubview(profileGrid); profileGrid.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let help = NSTextField(wrappingLabelWithString: "Esempio frontend: model: \"profile:fast\". Puoi assegnare lo stesso modello a più profili. *Il formato dei job supporta ancora messaggi testuali; il profilo vision non aggiunge immagini. I modelli devono essere disponibili nei loro runtime.")
        help.font = .systemFont(ofSize: 12); help.textColor = .secondaryLabelColor
        stack.addArrangedSubview(help); help.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        save.target = self; save.action = #selector(apply); save.bezelStyle = .rounded; save.bezelColor = .systemTeal; save.controlSize = .large
        stack.addArrangedSubview(save)
        message.font = .systemFont(ofSize: 12); message.textColor = .secondaryLabelColor
        stack.addArrangedSubview(message); message.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        refreshDestinations(); refreshProfiles(); showDestination()
    }
    func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func refreshDestinations() {
        destination.removeAllItems(); destination.addItems(withTitles: routing.destinations.map { "\($0.name) · \($0.kind == .cloud ? "cloud" : "locale")" })
        destination.selectItem(at: selected)
    }
    func captureProfiles() {
        routing.profiles = selectors.reduce(into: [:]) { result, pair in
            if let id = pair.value.selectedItem?.representedObject as? String { result[pair.key] = id }
        }
    }
    func refreshProfiles() {
        for (profile, popup) in selectors {
            popup.removeAllItems(); popup.addItem(withTitle: "Non assegnato")
            for item in routing.destinations {
                popup.addItem(withTitle: "\(item.name) · \(item.kind == .cloud ? "cloud" : "locale")")
                popup.lastItem?.representedObject = item.id
                if routing.profiles[profile] == item.id { popup.select(popup.lastItem) }
            }
        }
    }
    func showDestination() {
        guard routing.destinations.indices.contains(selected) else { return }
        let value = routing.destinations[selected]
        name.stringValue = value.name; model.stringValue = value.model; endpoint.stringValue = value.runtimeUrl
        secret.stringValue = value.runtimeKey ?? ""; kind.selectItem(at: value.kind == .cloud ? 1 : 0)
        approval.state = value.cloudApproved ? .on : .off; kindChanged()
    }
    @discardableResult func captureDestination() -> Bool {
        guard routing.destinations.indices.contains(selected) else { return false }
        let clean = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !clean(name.stringValue).isEmpty, !clean(model.stringValue).isEmpty,
              let url = URL(string: clean(endpoint.stringValue)), ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            message.stringValue = "Compila nome, modello e un endpoint HTTP(S) senza credenziali nell’URL."; return false
        }
        let cloud = kind.indexOfSelectedItem == 1
        if cloud && approval.state != .on { message.stringValue = "Per il cloud devi consentire esplicitamente invio dei prompt e costi."; return false }
        let id = routing.destinations[selected].id
        routing.destinations[selected] = ModelDestination(id: id, name: clean(name.stringValue), model: clean(model.stringValue), runtimeUrl: clean(endpoint.stringValue), runtimeKey: secret.stringValue.isEmpty ? nil : secret.stringValue, kind: cloud ? .cloud : .local, cloudApproved: cloud && approval.state == .on)
        return true
    }
    @objc func kindChanged() { approval.isEnabled = kind.indexOfSelectedItem == 1 }
    @objc func selectDestination() {
        let next = destination.indexOfSelectedItem
        guard captureDestination() else { destination.selectItem(at: selected); return }
        captureProfiles(); selected = next; refreshDestinations(); refreshProfiles(); showDestination(); message.stringValue = ""
    }
    @objc func addDestination() {
        guard captureDestination() else { return }; captureProfiles()
        if routing.destinations.count >= 32 { message.stringValue = "Sono consentite al massimo 32 destinazioni."; return }
        routing.destinations.append(ModelDestination(id: UUID().uuidString, name: "Nuovo modello", model: "", runtimeUrl: "http://127.0.0.1:11434/v1", kind: .local, cloudApproved: false))
        selected = routing.destinations.count - 1; refreshDestinations(); refreshProfiles(); showDestination()
    }
    @objc func removeDestination() {
        guard routing.destinations.count > 1 else { message.stringValue = "Mantieni almeno una destinazione."; return }
        captureProfiles(); let id = routing.destinations.remove(at: selected).id
        routing.profiles = routing.profiles.filter { $0.value != id }; selected = 0
        refreshDestinations(); refreshProfiles(); showDestination()
    }
    @objc func apply() {
        guard captureDestination() else { return }; captureProfiles()
        if let id = routing.profiles["cloud"], routing.destinations.first(where: { $0.id == id })?.kind != .cloud {
            message.stringValue = "Il profilo cloud deve usare una destinazione cloud, oppure restare non assegnato."; return
        }
        save.isEnabled = false; message.stringValue = "Salvataggio…"
        onSave(routing) { error in
            self.save.isEnabled = true
            self.message.stringValue = error ?? "Salvato. I nuovi job useranno questi profili; quello in corso continua senza interruzioni."
            if error == nil { self.refreshDestinations(); self.refreshProfiles() }
        }
    }
}
