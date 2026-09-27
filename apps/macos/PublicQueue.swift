import AppKit
import ServiceManagement

final class TopView: NSView { override var isFlipped: Bool { true } }

// The UI owns one child agent. Closing the app closes its stdin, so no orphan worker survives.
final class PublicQueueApp: NSObject, NSApplicationDelegate {
    let defaults = UserDefaults.standard
    let defaultRelay = "https://jobboard.grokked.it"
    var item: NSStatusItem!
    var window: NSWindow!
    let rootStack = NSStackView()
    let document = TopView()
    var worker: Process?
    var pairing: Process?
    var input: Pipe?
    var dashboard: URL?
    var poller: Timer?
    var polling = false
    var stopping = false
    var retry: DispatchWorkItem?
    var stdoutBuffer = ""
    let headline = NSTextField(labelWithString: "")
    let subtitle = NSTextField(wrappingLabelWithString: "")
    let stateLabel = NSTextField(labelWithString: "")
    let modelLabel = NSTextField(wrappingLabelWithString: "")
    let relayLabel = NSTextField(labelWithString: "")
    var connectedBox: NSBox!
    let setup = NSStackView()
    let advanced = NSStackView()
    let frontend = NSStackView()
    let editButton = NSButton()
    let frontendButton = NSButton()
    let status = NSMenuItem(title: "Non collegato", action: nil, keyEquivalent: "")
    let openItem = NSMenuItem(title: "Apri la coda nel browser", action: #selector(openDashboard), keyEquivalent: "")
    let relay = NSTextField(string: "https://jobboard.grokked.it")
    let runtime = NSPopUpButton()
    let runtimeURL = NSTextField(string: "http://127.0.0.1:11434/v1")
    let models = NSTextField(string: "")
    let code = NSTextField(string: "")
    let runtimeKey = NSSecureTextField(string: "")
    let message = NSTextField(wrappingLabelWithString: "")
    let key = NSTextField(string: "")
    let login = NSButton(checkboxWithTitle: "Open automatically at login", target: nil, action: nil)
    let connectButton = NSButton(title: "Connect this Mac", target: nil, action: nil)
    let startItem = NSMenuItem(title: "Avvia agent", action: #selector(toggleWorker), keyEquivalent: "")
    let presets = ["Ollama": "http://127.0.0.1:11434/v1", "LM Studio": "http://127.0.0.1:1234/v1", "llama.cpp": "http://127.0.0.1:8080/v1", "oMLX": "http://127.0.0.1:8000/v1", "vLLM": "http://127.0.0.1:8000/v1"]
    var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Public Queue", isDirectory: true)
    }
    var selected: URL? {
        guard let name = defaults.string(forKey: "configuration"), name == URL(fileURLWithPath: name).lastPathComponent else { return nil }
        return directory.appendingPathComponent(name)
    }
    func configuration() -> [String: Any]? {
        guard let path = selected, let data = try? Data(contentsOf: path) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil); return
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let icon = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            NSColor.black.set()
            for i in 0..<3 {
                let shape = NSBezierPath(roundedRect: NSRect(x: 2 + i * 6, y: 3, width: 4, height: i == 2 ? 8 : 12), xRadius: 0.5, yRadius: 0.5)
                if i == 0 { shape.fill() } else { shape.lineWidth = 1; shape.stroke() }
            }
            return true
        }
        icon.isTemplate = true; item.button?.image = icon
        item.button?.setAccessibilityLabel("Public Queue")
        let menu = NSMenu(); menu.autoenablesItems = false
        let title = NSMenuItem(title: "Public Queue", action: nil, keyEquivalent: ""); title.isEnabled = false
        status.isEnabled = false
        menu.addItem(title)
        menu.addItem(status); menu.addItem(.separator())
        for entry in [openItem, NSMenuItem(title: "Apri Public Queue…", action: #selector(showSettings), keyEquivalent: ","), startItem] {
            entry.target = self; menu.addItem(entry)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Esci da Public Queue", action: #selector(quit), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit); item.menu = menu
        openItem.isEnabled = false
        let mainMenu = NSMenu()
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        edit.submenu = editMenu; mainMenu.addItem(edit); NSApp.mainMenu = mainMenu
        createSettings()
        if SMAppService.mainApp.status == .enabled && defaults.string(forKey: "registeredPath") != Bundle.main.bundlePath {
            login.state = .on; loginChanged()
        }
        if configuration() != nil { startWorker() } else { showSettings() }
        poller = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showSettings(); return true }
    func createSettings() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 650), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Public Queue"; window.isReleasedWhenClosed = false; window.center()
        window.titlebarAppearsTransparent = true; window.backgroundColor = .windowBackgroundColor
        let scroll = NSScrollView(frame: window.contentView!.bounds)
        scroll.autoresizingMask = [.width, .height]; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        document.frame = NSRect(x: 0, y: 0, width: 600, height: 800); scroll.documentView = document
        window.contentView!.addSubview(scroll)
        let stack = rootStack; stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 24)])
        let brand = label("▥  PUBLIC QUEUE", 12, .semibold); brand.textColor = .systemTeal; stack.addArrangedSubview(brand)
        headline.font = .systemFont(ofSize: 29, weight: .bold); stack.addArrangedSubview(headline)
        subtitle.font = .systemFont(ofSize: 13); subtitle.textColor = .secondaryLabelColor
        stack.addArrangedSubview(subtitle); subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        let connected = NSStackView(); connected.orientation = .vertical; connected.alignment = .leading; connected.spacing = 13
        stateLabel.font = .systemFont(ofSize: 14, weight: .semibold); stateLabel.textColor = .systemTeal
        connected.addArrangedSubview(stateLabel)
        modelLabel.font = .systemFont(ofSize: 22, weight: .semibold); connected.addArrangedSubview(modelLabel)
        relayLabel.textColor = .secondaryLabelColor; connected.addArrangedSubview(relayLabel)
        let browser = button("Apri la coda nel browser  ↗", #selector(openDashboard), primary: true)
        connected.addArrangedSubview(browser)
        connected.addArrangedSubview(label("Vedi richieste in attesa, in esecuzione e completate.", 12))
        connectedBox = card(connected, tinted: true); stack.addArrangedSubview(connectedBox)
        connectedBox.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        setup.orientation = .vertical; setup.alignment = .leading; setup.spacing = 12
        let model = NSStackView(); model.orientation = .vertical; model.alignment = .leading; model.spacing = 9
        model.addArrangedSubview(label("1   Quale app esegue il tuo modello?", 14, .semibold))
        runtime.addItems(withTitles: ["Ollama", "LM Studio", "llama.cpp", "oMLX", "vLLM", "Altro server compatibile"])
        runtime.target = self; runtime.action = #selector(runtimeChanged); runtime.controlSize = .large
        model.addArrangedSubview(runtime); runtime.widthAnchor.constraint(equalTo: model.widthAnchor).isActive = true
        model.addArrangedSubview(label("Tienila aperta con un modello caricato. Public Queue non la avvia.", 12))
        let advancedButton = button("Impostazioni avanzate…", #selector(toggleAdvanced)); model.addArrangedSubview(advancedButton)
        advanced.orientation = .vertical; advanced.alignment = .leading; advanced.spacing = 7; advanced.isHidden = true
        func field(_ title: String, _ control: NSView) {
            advanced.addArrangedSubview(label(title, 12, .medium)); advanced.addArrangedSubview(control)
            control.widthAnchor.constraint(equalTo: advanced.widthAnchor).isActive = true
        }
        field("Sito della coda", relay); field("Indirizzo del modello (con /v1)", runtimeURL)
        models.placeholderString = "Vuoto = primo modello disponibile"; field("Modelli consentiti, separati da virgole", models)
        runtimeKey.placeholderString = "Solo se il tuo runtime richiede una chiave"; field("Chiave API del runtime (facoltativa)", runtimeKey)
        model.addArrangedSubview(advanced); advanced.widthAnchor.constraint(equalTo: model.widthAnchor).isActive = true
        let modelCard = card(model); setup.addArrangedSubview(modelCard); modelCard.widthAnchor.constraint(equalTo: setup.widthAnchor).isActive = true
        let pairingCard = NSStackView(); pairingCard.orientation = .vertical; pairingCard.alignment = .leading; pairingCard.spacing = 10
        pairingCard.addArrangedSubview(label("2   Collega il Mac alla tua coda", 14, .semibold))
        pairingCard.addArrangedSubview(label("Crea un dispositivo sul sito e incolla qui il codice di abbinamento.", 12))
        pairingCard.addArrangedSubview(button("Ottieni un codice sul sito  ↗", #selector(openConsole)))
        code.placeholderString = "Incolla il codice di abbinamento"; code.controlSize = .large
        pairingCard.addArrangedSubview(code); code.widthAnchor.constraint(equalTo: pairingCard.widthAnchor).isActive = true
        connectButton.title = "Collega questo Mac"; connectButton.target = self; connectButton.action = #selector(connect)
        connectButton.bezelStyle = .rounded; connectButton.controlSize = .large; connectButton.bezelColor = .systemTeal
        pairingCard.addArrangedSubview(connectButton)
        let box = card(pairingCard); setup.addArrangedSubview(box); box.widthAnchor.constraint(equalTo: setup.widthAnchor).isActive = true
        stack.addArrangedSubview(setup); setup.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        login.title = "Avvia Public Queue quando accedo al Mac"
        login.target = self; login.action = #selector(loginChanged); login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        stack.addArrangedSubview(login)
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 14
        editButton.title = "Modifica connessione…"; editButton.target = self; editButton.action = #selector(toggleSetup); editButton.bezelStyle = .rounded
        frontendButton.title = "Collega un frontend…"; frontendButton.target = self; frontendButton.action = #selector(toggleFrontend); frontendButton.bezelStyle = .rounded
        row.addArrangedSubview(editButton); row.addArrangedSubview(frontendButton); stack.addArrangedSubview(row)
        frontend.orientation = .vertical; frontend.alignment = .leading; frontend.spacing = 8; frontend.isHidden = true
        frontend.addArrangedSubview(label("Per inviare richieste a questo Mac, crea una connessione browser\nnella console e verifica il dispositivo con questa chiave pubblica.", 12))
        key.isEditable = false; key.isSelectable = true; key.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        frontend.addArrangedSubview(key); key.widthAnchor.constraint(equalTo: frontend.widthAnchor).isActive = true
        let keyActions = NSStackView(views: [button("Copia chiave pubblica", #selector(copyKey)), button("Apri console  ↗", #selector(openConsole))]); keyActions.spacing = 12
        frontend.addArrangedSubview(keyActions); stack.addArrangedSubview(frontend); frontend.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        message.font = .systemFont(ofSize: 12); message.textColor = .secondaryLabelColor
        stack.addArrangedSubview(message); message.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let foot = label("Chiudi questa finestra: l’app resta nella barra dei menu.\nPer fermarla, scegli “Esci da Public Queue” dall’icona ▥.", 12)
        foot.textColor = .secondaryLabelColor; stack.addArrangedSubview(foot)
        if let config = configuration() {
            relay.stringValue = config["server"] as? String ?? defaultRelay
            runtimeURL.stringValue = config["runtimeUrl"] as? String ?? runtimeURL.stringValue
            models.stringValue = (config["models"] as? [String] ?? []).joined(separator: ", ")
            runtime.selectItem(withTitle: defaults.string(forKey: "runtimeName") ?? "Altro server compatibile")
        }
        updateConnectionView()
    }
    func label(_ text: String, _ size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text); label.font = .systemFont(ofSize: size, weight: weight)
        return label
    }
    func button(_ title: String, _ action: Selector, primary: Bool = false) -> NSButton {
        let button = NSButton(title: title, target: self, action: action); button.bezelStyle = .rounded
        button.controlSize = primary ? .large : .regular
        if primary { button.bezelColor = .systemTeal; button.font = .systemFont(ofSize: 15, weight: .semibold) }
        return button
    }
    func card(_ content: NSStackView, tinted: Bool = false) -> NSBox {
        let box = NSBox(); box.boxType = .custom; box.cornerRadius = 12; box.borderWidth = 1
        box.borderColor = tinted ? NSColor.systemTeal.withAlphaComponent(0.3) : NSColor.separatorColor
        box.fillColor = tinted ? NSColor.systemTeal.withAlphaComponent(0.08) : NSColor.controlBackgroundColor
        box.contentViewMargins = NSSize(width: 0, height: 0)
        content.translatesAutoresizingMaskIntoConstraints = false; box.contentView!.addSubview(content)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor, constant: 16), content.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor, constant: -16), content.topAnchor.constraint(equalTo: box.contentView!.topAnchor, constant: 16), content.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor, constant: -16)])
        return box
    }
    func updateConnectionView() {
        let config = configuration(); let paired = config != nil
        headline.stringValue = paired ? "Il tuo Mac è collegato." : "Porta i tuoi modelli online."
        subtitle.stringValue = paired ? "Public Queue riceve i job dal sito e li esegue sul tuo modello.\nIl Mac comunica solo verso l’esterno: nessuna porta da aprire." : "Il ponte tra il tuo frontend e i modelli sul Mac.\nDue passaggi, poi tutto funziona dalla barra dei menu."
        setup.isHidden = paired; connectedBox.isHidden = !paired
        editButton.isHidden = !paired; frontendButton.isHidden = !paired
        key.stringValue = config?["publicKey"] as? String ?? ""
        modelLabel.stringValue = (config?["models"] as? [String] ?? []).joined(separator: ", ")
        relayLabel.stringValue = URL(string: config?["server"] as? String ?? defaultRelay)?.host ?? defaultRelay
        stateLabel.stringValue = paired ? "●  Agent in avvio" : "Non collegato"
        message.stringValue = ""
        resizeWindow()
    }
    func resizeWindow() {
        let paired = configuration() != nil
        let height: CGFloat = setup.isHidden ? (frontend.isHidden ? 545 : 650) : (advanced.isHidden ? (paired ? 910 : 700) : (paired ? 1150 : 945))
        // Advanced connection editing replaces the summary, keeping the form within laptop displays.
        connectedBox.isHidden = !setup.isHidden || !paired
        let adjusted = !setup.isHidden && paired ? height - 205 : height
        let maxHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        window.setContentSize(NSSize(width: 600, height: min(adjusted, maxHeight - 60)))
        document.layoutSubtreeIfNeeded()
        document.setFrameSize(NSSize(width: 600, height: max(rootStack.fittingSize.height + 48, window.contentView!.bounds.height)))
    }
    @objc func toggleSetup() {
        setup.isHidden.toggle(); frontend.isHidden = true
        editButton.title = setup.isHidden ? "Modifica connessione…" : "Annulla modifiche"
        message.stringValue = setup.isHidden ? "" : "La connessione attuale resta attiva. Per sostituirla serve un nuovo codice."
        resizeWindow()
    }
    @objc func toggleAdvanced() { advanced.isHidden.toggle(); resizeWindow() }
    @objc func toggleFrontend() { frontend.isHidden.toggle(); resizeWindow() }
    @objc func copyKey() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(key.stringValue, forType: .string); message.stringValue = "Chiave pubblica copiata. Incollala nella console del sito." }
    @objc func showSettings() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func runtimeChanged() { if let name = runtime.titleOfSelectedItem, let url = presets[name] { runtimeURL.stringValue = url } }
    func validRelay() -> URL? {
        guard let url = URL(string: relay.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)) else {
            message.stringValue = "Inserisci un sito HTTPS. HTTP è consentito solo per localhost."; return nil
        }
        return url
    }
    @objc func openConsole() { if let url = validRelay() { NSWorkspace.shared.open(url.appendingPathComponent("console/")) } }
    func process(_ args: [String]) -> Process {
        let task = Process()
        task.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
        task.arguments = [Bundle.main.resourceURL!.appendingPathComponent("agent/cli.js").path] + args
        // Do not inherit NODE_OPTIONS or third-party Node loader settings into the packaged app.
        task.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": NSTemporaryDirectory()]
        return task
    }
    @objc func connect() {
        guard pairing == nil, let server = validRelay() else { return }
        let pairingCode = code.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pairingCode.isEmpty else { message.stringValue = "Apri il sito, crea un dispositivo e incolla qui il codice di abbinamento."; return }
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { message.stringValue = "Cannot create private configuration folder: \(error.localizedDescription)"; return }
        let destination = directory.appendingPathComponent("agent-\(UUID().uuidString).json")
        var args = ["connect", "--server", server.absoluteString, "--code", pairingCode, "--runtime", "custom", "--runtime-url", runtimeURL.stringValue, "--config", destination.path]
        if !models.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { args += ["--models", models.stringValue] }
        let task = process(args)
        if !runtimeKey.stringValue.isEmpty { task.environment?["PQ_RUNTIME_KEY"] = runtimeKey.stringValue }
        let output = Pipe(); task.standardOutput = output; task.standardError = output; task.standardInput = FileHandle.nullDevice
        pairing = task; connectButton.isEnabled = false; message.stringValue = "Controllo il modello e collego il Mac…"
        // Read concurrently so a large model list cannot fill the pipe and deadlock pairing.
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard self.pairing === task else { return }
                task.waitUntilExit(); self.pairing = nil; self.connectButton.isEnabled = true
                if task.terminationStatus == 0 && FileManager.default.fileExists(atPath: destination.path) {
                    self.stopWorker(); self.defaults.set(destination.lastPathComponent, forKey: "configuration")
                    self.key.stringValue = self.configuration()?["publicKey"] as? String ?? ""
                    self.code.stringValue = ""; self.runtimeKey.stringValue = ""
                    self.defaults.set(self.runtime.titleOfSelectedItem, forKey: "runtimeName"); self.updateConnectionView()
                    if !self.defaults.bool(forKey: "loginPreferenceSet") { self.login.state = .on; self.loginChanged() }
                    self.startWorker()
                } else {
                    let text = String(data: data, encoding: .utf8) ?? "Pairing failed."
                    self.message.stringValue = String(text.suffix(700))
                    try? FileManager.default.removeItem(at: destination)
                }
            }
        }
        do { try task.run() }
        catch {
            output.fileHandleForWriting.closeFile(); pairing = nil; connectButton.isEnabled = true
            message.stringValue = "Could not start the bundled agent: \(error.localizedDescription)"
        }
    }
    @objc func loginChanged() {
        defaults.set(true, forKey: "loginPreferenceSet")
        do {
            if login.state == .on {
                if SMAppService.mainApp.status == .enabled && defaults.string(forKey: "registeredPath") != Bundle.main.bundlePath { try SMAppService.mainApp.unregister() }
                try SMAppService.mainApp.register()
                defaults.set(Bundle.main.bundlePath, forKey: "registeredPath")
            } else { try SMAppService.mainApp.unregister() }
            if SMAppService.mainApp.status == .requiresApproval { message.stringValue = "Consenti Public Queue in Impostazioni di Sistema → Generali → Elementi login." }
        } catch { login.state = SMAppService.mainApp.status == .enabled ? .on : .off; message.stringValue = "Avvio al login: \(error.localizedDescription). Sposta prima l’app in Applicazioni." }
    }
    func startWorker() {
        guard worker == nil, let path = selected else { return }
        stopping = false; retry?.cancel(); stdoutBuffer = ""
        let task = process(["start", "--desktop-host", "--config", path.path])
        let pipe = Pipe(); let feed = Pipe(); task.standardOutput = pipe; task.standardError = FileHandle.nullDevice; task.standardInput = feed
        worker = task; input = feed; status.title = "Agent in avvio…"; startItem.title = "Ferma agent"
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.readOutput(text) }
        }
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, self.worker === task else { return }
                self.worker = nil; self.input = nil; self.dashboard = nil; self.openItem.isEnabled = false
                self.status.title = "Agent fermo — riprovo tra 10 secondi"
                if !self.stopping {
                    let retry = DispatchWorkItem { [weak self] in self?.startWorker() }
                    self.retry = retry; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: retry)
                }
            }
        }
        do { try task.run() }
        catch { worker = nil; input = nil; status.title = "Impossibile avviare l’agent"; message.stringValue = error.localizedDescription }
    }
    func readOutput(_ text: String) {
        stdoutBuffer += text
        while let end = stdoutBuffer.firstIndex(of: "\n") {
            let line = String(stdoutBuffer[..<end]); stdoutBuffer.removeSubrange(...end)
            if line.hasPrefix("Local dashboard: "), let url = URL(string: String(line.dropFirst(17))), url.host == "127.0.0.1", url.scheme == "http", url.fragment?.count == 64 {
                dashboard = url; openItem.isEnabled = true; status.title = "Agent attivo"; refresh()
            }
        }
        if stdoutBuffer.count > 8192 { stdoutBuffer = "" }
    }
    func stopWorker() {
        stopping = true; retry?.cancel(); retry = nil
        input?.fileHandleForWriting.closeFile(); input = nil
        if let task = worker, task.isRunning {
            task.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if task.isRunning { kill(task.processIdentifier, SIGKILL) } }
        }
        worker = nil; dashboard = nil; openItem.isEnabled = false; status.title = "Agent fermo"; stateLabel.stringValue = "○  Agent fermo"; startItem.title = "Avvia agent"
    }
    @objc func toggleWorker() { if worker == nil { startWorker() } else { stopWorker() } }
    func refresh() {
        guard !polling, let url = dashboard, let token = url.fragment else { return }
        polling = true
        var request = URLRequest(url: URL(string: "/api/status", relativeTo: url)!.absoluteURL)
        request.timeoutInterval = 5; request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self = self else { return }; self.polling = false
                guard self.dashboard == url else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   let queue = json?["queue"] as? [String: Any], let counts = queue["counts"] as? [String: Int] {
                    self.stateLabel.textColor = .systemTeal
                    self.status.title = "\(counts["queued", default: 0]) in attesa · \(counts["running", default: 0]) in esecuzione"
                } else { self.stateLabel.textColor = .systemOrange; self.status.title = "Coda non raggiungibile — apri la dashboard" }
                self.stateLabel.stringValue = "●  \(self.status.title)"
                self.item.button?.toolTip = "Public Queue — \(self.status.title)"
            }
        }.resume()
    }
    @objc func openDashboard() { if let url = dashboard { NSWorkspace.shared.open(url) } else { showSettings() } }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        poller?.invalidate(); stopWorker()
        if let task = pairing, task.isRunning { task.terminate() }
    }
}

if CommandLine.arguments.contains("--check") {
    guard let resources = Bundle.main.resourceURL,
          FileManager.default.isExecutableFile(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path),
          FileManager.default.fileExists(atPath: resources.appendingPathComponent("agent/cli.js").path) else { exit(1) }
    print("Public Queue app: bundled runtime and agent present")
    exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = PublicQueueApp()
app.delegate = delegate
app.run()
