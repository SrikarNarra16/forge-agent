// PDF inspection with macOS PDFKit (no poppler needed):
//   pdf-tool pages  file.pdf              -> page count
//   pdf-tool text   file.pdf              -> the text layer, one "=== page n ===" block per page
//   pdf-tool links  file.pdf              -> every link annotation URL (page, url)
//   pdf-tool png    file.pdf outDir [dpi] -> page-<n>.png for every page (default 110 dpi)
//   pdf-tool fonts  file.pdf              -> unused (fonts are checked by the caller on the raw bytes)
import AppKit
import Foundation
import PDFKit

func die(_ m: String) -> Never {
    FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: pdf-tool pages|text|links|png file.pdf [outDir] [dpi]") }
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { die("cannot open \(args[2])") }

switch args[1] {
case "pages":
    print(doc.pageCount)
case "text":
    for i in 0..<doc.pageCount {
        print("=== page \(i + 1) ===")
        print(doc.page(at: i)?.string ?? "")
    }
case "links":
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        for a in page.annotations {
            if let url = a.url { print("page \(i + 1)\t\(url.absoluteString)") }
            else if let action = a.action as? PDFActionURL, let url = action.url { print("page \(i + 1)\t\(url.absoluteString)") }
        }
    }
case "png":
    guard args.count >= 4 else { die("png needs an output directory") }
    let dpi = args.count >= 5 ? Double(args[4]) ?? 110 : 110
    try? FileManager.default.createDirectory(atPath: args[3], withIntermediateDirectories: true)
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let box = page.bounds(for: .mediaBox)
        let scale = dpi / 72.0
        let w = Int(box.width * scale), h = Int(box.height * scale)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { die("bitmap") }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: w, height: h).fill()
        let cg = ctx.cgContext
        cg.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: cg)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { die("png") }
        let path = "\(args[3])/page-\(i + 1).png"
        try? png.write(to: URL(fileURLWithPath: path))
        print(path)
    }
default:
    die("unknown command \(args[1])")
}
