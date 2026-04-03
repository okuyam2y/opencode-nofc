import Foundation
import Vision
import ImageIO

let paths = Array(CommandLine.arguments.dropFirst())
for (i, path) in paths.enumerated() {
  let url = URL(fileURLWithPath: path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["ja-JP", "en-US"]
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try? handler.perform([request])
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  if !lines.isEmpty {
    print("--- Page \(i + 1) ---")
    print(lines.joined(separator: "\n"))
    print()
  }
}
