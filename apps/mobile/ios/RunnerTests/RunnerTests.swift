import Flutter
import UIKit
import XCTest
import ImageIO
@testable import Runner

class RunnerTests: XCTestCase {
  private var pasteboardName: UIPasteboard.Name!
  private var pasteboard: UIPasteboard!

  override func setUp() {
    super.setUp()
    pasteboardName = UIPasteboard.Name("eco-image-clipboard-test-\(UUID().uuidString)")
    pasteboard = UIPasteboard(name: pasteboardName, create: true)
  }

  override func tearDown() {
    UIPasteboard.remove(withName: pasteboardName)
    super.tearDown()
  }

  func testCopiesOriginalPngDataUnderItsImageType() throws {
    let bytes = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!

    try EcoImageClipboard.copy(bytes, to: pasteboard)

    XCTAssertEqual(pasteboard.data(forPasteboardType: "public.png"), bytes)
    XCTAssertTrue(pasteboard.contains(pasteboardTypes: ["public.png"]))
  }

  func testRejectsInvalidDataWithoutReplacingExistingClipboardContent() {
    let existing = Data([1, 2, 3])
    pasteboard.setData(existing, forPasteboardType: "public.data")

    XCTAssertThrowsError(try EcoImageClipboard.copy(Data([0, 1, 2]), to: pasteboard))
    XCTAssertEqual(pasteboard.data(forPasteboardType: "public.data"), existing)
  }

  func testCopiesJpegBytesWithoutTranscodingThem() throws {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(
      data: nil,
      width: 2,
      height: 2,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )!
    context.setFillColor(UIColor.systemTeal.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
    let image = context.makeImage()!
    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let bytes = output as Data

    try EcoImageClipboard.copy(bytes, to: pasteboard)

    XCTAssertEqual(pasteboard.data(forPasteboardType: "public.jpeg"), bytes)
    XCTAssertNil(pasteboard.data(forPasteboardType: "public.png"))
  }
}
