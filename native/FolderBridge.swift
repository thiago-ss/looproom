import AppKit
import Foundation
// Invoked only by the authenticated local broker after a choose/drop gesture.
func emit(_ value: [String: Any]) { let data = try! JSONSerialization.data(withJSONObject: value); print(String(data: data, encoding: .utf8)!) }
let mode = CommandLine.arguments.dropFirst().first ?? "choose"
if mode == "drop" {
    let board = NSPasteboard(name: .drag)
    let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    let names = Set(CommandLine.arguments.dropFirst(2))
    let matching = urls.filter { names.contains($0.lastPathComponent) }
    if matching.count == 1 { emit(["path": matching[0].path]) } else { emit(["path": NSNull()]) }
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.finishLaunching()
    app.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.title = "Choose a Looproom project folder"
    panel.message = "Choose a folder, or drag one here from Finder. Your files stay on this Mac."
    panel.prompt = "Use folder"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = false
    panel.allowsMultipleSelection = false
    if let path = CommandLine.arguments.dropFirst(2).first, !path.isEmpty { panel.directoryURL = URL(fileURLWithPath: path) }
    emit(["path": panel.runModal() == .OK ? panel.url!.path : NSNull()])
}
