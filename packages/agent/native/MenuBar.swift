import AppKit

struct Snapshot: Decodable {
    struct Queue: Decodable { let counts: [String: Int] }
    let queue: Queue
}

final class MenuBar: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var timer: Timer?
    var fetching = false
    let summary = NSMenuItem(title: "Connecting to relay…", action: nil, keyEquivalent: "")
    let dashboard: URL
    let endpoint: URL
    let token: String
    let monitor: Bool

    init(dashboard: URL, monitor: Bool) {
        self.dashboard = dashboard
        self.monitor = monitor
        token = dashboard.fragment!
        endpoint = URL(string: "/api/status", relativeTo: dashboard)!.absoluteURL
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let icon = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            NSColor.black.set()
            for i in 0..<3 {
                let rect = NSRect(x: 2 + i * 6, y: 3, width: 4, height: i == 2 ? 8 : 12)
                let path = NSBezierPath(roundedRect: rect, xRadius: 0.5, yRadius: 0.5)
                if i == 0 { path.fill() } else { path.lineWidth = 1; path.stroke() }
            }
            return true
        }
        icon.isTemplate = true
        item.button?.image = icon
        item.button?.toolTip = "Public Queue"
        item.button?.setAccessibilityLabel("Public Queue")
        let menu = NSMenu()
        let title = NSMenuItem(title: monitor ? "Public Queue · Monitor" : "Public Queue · Agent", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        summary.isEnabled = false
        menu.addItem(summary)
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: monitor ? "Close monitor" : "Quit agent", action: #selector(quitAgent), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        // If the owning Node process exits or crashes, remove the status item too.
        FileHandle.standardInput.readabilityHandler = { handle in
            if handle.availableData.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        print("ready"); fflush(stdout)
    }
    func refresh() {
        if fetching { return }
        fetching = true
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let snapshot: Snapshot? = (response as? HTTPURLResponse)?.statusCode == 200
                ? data.flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } : nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.fetching = false
                if let counts = snapshot?.queue.counts {
                    self.summary.title = "\(counts["queued", default: 0]) waiting · \(counts["running", default: 0]) running"
                } else {
                    self.summary.title = "Queue unavailable · Open dashboard"
                }
                self.item.button?.toolTip = "Public Queue — \(self.summary.title)"
            }
        }.resume()
    }
    @objc func openDashboard() { NSWorkspace.shared.open(dashboard) }
    @objc func quitAgent() {
        print("quit"); fflush(stdout)
        NSApp.terminate(nil)
    }
}

if CommandLine.arguments.dropFirst().first == "--check" {
    print("Public Queue menu bar helper · macOS 13+")
    exit(0)
}
guard CommandLine.arguments.count == 3,
      let url = URL(string: CommandLine.arguments[1]), url.scheme == "http", url.host == "127.0.0.1",
      let fragment = url.fragment, fragment.count == 64, fragment.allSatisfy({ $0.isHexDigit }),
      ["agent", "monitor"].contains(CommandLine.arguments[2]) else {
    fputs("Expected a local dashboard URL and agent|monitor mode.\n", stderr)
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = MenuBar(dashboard: url, monitor: CommandLine.arguments[2] == "monitor")
app.delegate = delegate
app.run()
