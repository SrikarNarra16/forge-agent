// Assembles an H.264 MP4 from JPEG frames, using only what ships with macOS (AVFoundation + ImageIO); no ffmpeg.
//
//   swiftc -O scripts/video/assemble.swift -o e2e-output/video/bin/assemble
//   assemble manifest.json
//
// manifest.json:
//   { "out": "/abs/out.mp4", "marksOut": "/abs/marks.json", "width": 1920, "height": 1080, "fps": 30,
//     "clips": [
//       { "kind": "still", "file": "/abs/title.jpg", "seconds": 3, "name": "title" },
//       { "kind": "frames", "name": "taskA", "index": "/abs/clip/frames.json", "dir": "/abs/clip",
//         "speeds": [ { "t0": 12.5, "t1": 40.0, "factor": 3 } ],        // source seconds (relative to the clip start)
//         "marks":  [ { "name": "A1", "t": 8.2 } ] }                    // source seconds; reported as FINAL video times
//     ] }
// frames.json: [ { "f": "000001.jpg", "t": 0.012 }, ... ]   (seconds since the clip start, ascending)
//
// Each clip is resampled to a constant `fps` (the latest frame at or before each output instant is shown; the screencast only
// delivers frames when the screen changes). A speed range compresses that part of the source timeline by `factor`.
import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

struct Speed: Decodable { let t0: Double; let t1: Double; let factor: Double }
struct Mark: Decodable { let name: String; let t: Double }
struct FrameRef: Decodable { let f: String; let t: Double }
struct Clip: Decodable {
    let kind: String
    let name: String?
    let file: String?
    let seconds: Double?
    let index: String?
    let dir: String?
    let speeds: [Speed]?
    let marks: [Mark]?
    let trimStart: Double?
    let trimEnd: Double?
}
struct Manifest: Decodable {
    let out: String
    let marksOut: String?
    let width: Int
    let height: Int
    let fps: Int
    let clips: [Clip]
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: assemble manifest.json") }
let manifest: Manifest
do {
    manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
} catch { fail("bad manifest: \(error)") }

let W = manifest.width, H = manifest.height, FPS = manifest.fps
try? FileManager.default.removeItem(atPath: manifest.out)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: manifest.out), fileType: .mp4) } catch { fail("writer: \(error)") }
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W,
    AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 6_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: FPS * 2,
        AVVideoExpectedSourceFrameRateKey: FPS,
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: W,
        kCVPixelBufferHeightKey as String: H,
    ])
writer.add(input)
guard writer.startWriting() else { fail("startWriting: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

let colorSpace = CGColorSpaceCreateDeviceRGB()

func pixelBuffer(from path: String) -> CVPixelBuffer {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot decode \(path)") }
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(nil, W, H, kCVPixelFormatType_32BGRA, nil, &pb)
    guard let buffer = pb else { fail("pixel buffer") }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer), width: W, height: H, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { fail("context") }
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    // scale to fit, centred (screencast frames should already be W x H)
    let iw = CGFloat(image.width), ih = CGFloat(image.height)
    let s = min(CGFloat(W) / iw, CGFloat(H) / ih)
    let dw = iw * s, dh = ih * s
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: (CGFloat(W) - dw) / 2, y: (CGFloat(H) - dh) / 2, width: dw, height: dh))
    return buffer
}

var outFrame = 0
func append(_ buffer: CVPixelBuffer) {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    let pts = CMTime(value: CMTimeValue(outFrame), timescale: CMTimeScale(FPS))
    if !adaptor.append(buffer, withPresentationTime: pts) { fail("append failed at frame \(outFrame): \(String(describing: writer.error))") }
    outFrame += 1
}

/// Output seconds (relative to the clip's start) for a source time, given sorted non-overlapping speed ranges.
func outputTime(_ t: Double, start: Double, speeds: [Speed]) -> Double {
    var out = 0.0
    var cursor = start
    for s in speeds.sorted(by: { $0.t0 < $1.t0 }) {
        let a = max(s.t0, start)
        if t <= a { break }
        out += a - cursor
        let b = min(t, s.t1)
        if b > a { out += (b - a) / s.factor }
        cursor = max(cursor, min(t, s.t1))
        if t <= s.t1 { return out }
    }
    return out + (t - cursor)
}

var marksOut: [String: Double] = [:]
var clipStartsOut: [String: Double] = [:]
var cache: (path: String, buffer: CVPixelBuffer)?
func cachedBuffer(_ path: String) -> CVPixelBuffer {
    if let c = cache, c.path == path { return c.buffer }
    let b = pixelBuffer(from: path)
    cache = (path, b)
    return b
}

for clip in manifest.clips {
    let clipOffset = Double(outFrame) / Double(FPS)
    if let n = clip.name { clipStartsOut[n] = clipOffset }
    switch clip.kind {
    case "still":
        guard let file = clip.file, let secs = clip.seconds else { fail("still needs file and seconds") }
        let buffer = pixelBuffer(from: file)
        for _ in 0..<Int((secs * Double(FPS)).rounded()) { append(buffer) }
    case "frames":
        guard let indexPath = clip.index, let dir = clip.dir else { fail("frames needs index and dir") }
        let frames: [FrameRef]
        do { frames = try JSONDecoder().decode([FrameRef].self, from: Data(contentsOf: URL(fileURLWithPath: indexPath))) } catch { fail("bad frames index: \(error)") }
        guard !frames.isEmpty else { fail("no frames in \(indexPath)") }
        let speeds = clip.speeds ?? []
        let start = clip.trimStart ?? frames[0].t
        let end = clip.trimEnd ?? frames[frames.count - 1].t
        let totalOut = outputTime(end, start: start, speeds: speeds)
        let count = max(1, Int((totalOut * Double(FPS)).rounded()))
        // walk output frames; invert the speed mapping incrementally
        var idx = 0
        for n in 0..<count {
            let o = Double(n) / Double(FPS)
            // source time for output time o
            var src = start
            var remaining = o
            var cursor = start
            var done = false
            for s in speeds.sorted(by: { $0.t0 < $1.t0 }) {
                let a = max(s.t0, start)
                if a > cursor {
                    let seg = a - cursor
                    if remaining <= seg { src = cursor + remaining; done = true; break }
                    remaining -= seg
                    cursor = a
                }
                let b = s.t1
                if b > cursor {
                    let seg = (b - cursor) / s.factor
                    if remaining <= seg { src = cursor + remaining * s.factor; done = true; break }
                    remaining -= seg
                    cursor = b
                }
            }
            if !done { src = cursor + remaining }
            while idx + 1 < frames.count && frames[idx + 1].t <= src { idx += 1 }
            append(cachedBuffer(dir + "/" + frames[idx].f))
        }
        for m in clip.marks ?? [] { marksOut[m.name] = clipOffset + outputTime(min(max(m.t, start), end), start: start, speeds: speeds) }
    default:
        fail("unknown clip kind \(clip.kind)")
    }
}

input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { fail("finish failed: \(String(describing: writer.error))") }
let total = Double(outFrame) / Double(FPS)
if let p = manifest.marksOut {
    let payload: [String: Any] = ["duration": total, "marks": marksOut, "clipStarts": clipStartsOut]
    try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: p))
}
print(String(format: "wrote %@ (%d frames, %.2f s)", manifest.out, outFrame, total))
