import AppKit
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 0.08, green: 0.34, blue: 0.31, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 210, yRadius: 210).fill()
NSColor(calibratedRed: 0.86, green: 0.97, blue: 0.90, alpha: 1).set()
for i in 0..<3 {
    let bar = NSBezierPath(roundedRect: NSRect(x: 232 + i * 210, y: 270, width: 140, height: i == 2 ? 300 : 480), xRadius: 20, yRadius: 20)
    if i == 0 { bar.fill() } else { bar.lineWidth = 20; bar.stroke() }
}
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("icon.png"))
