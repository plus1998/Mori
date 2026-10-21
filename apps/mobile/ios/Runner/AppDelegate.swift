import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(
    _ engineBridge: FlutterImplicitEngineBridge
  ) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    let registrar = engineBridge.applicationRegistrar
    let messenger = registrar.messenger()
    registrar.register(
      EcoMobileLiquidGlassActionButtonFactory(messenger: messenger),
      withId: "eco_mobile/liquid_glass_action_button"
    )
    registrar.register(
      EcoMobileIOS26SearchFieldFactory(messenger: messenger),
      withId: "eco_mobile/ios26_search_field"
    )
  }
}

private final class EcoMobileLiquidGlassActionButtonFactory: NSObject,
  FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func create(
    withFrame frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?
  ) -> FlutterPlatformView {
    EcoMobileLiquidGlassActionButton(
      frame: frame,
      viewIdentifier: viewId,
      arguments: args,
      binaryMessenger: messenger
    )
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}

private final class EcoMobileLiquidGlassActionButton: NSObject,
  FlutterPlatformView {
  private let container: UIView
  private let button: UIButton
  private let channel: FlutterMethodChannel
  private let label: String
  private let sfSymbol: String
  private var foregroundColor: UIColor
  private var isEnabled: Bool
  private var isDark: Bool

  init(
    frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?,
    binaryMessenger messenger: FlutterBinaryMessenger
  ) {
    container = UIView(frame: frame)
    button = UIButton(type: .system)
    let config = args as? [String: Any] ?? [:]
    label = config["label"] as? String ?? ""
    sfSymbol = config["sfSymbol"] as? String ?? "circle"
    foregroundColor = UIColor(argb: config["foregroundColor"] as? Int ?? 0xFF1D1D1F)
    isEnabled = config["enabled"] as? Bool ?? true
    isDark = config["isDark"] as? Bool ?? false
    channel = FlutterMethodChannel(
      name: "eco_mobile/liquid_glass_action_button_\(config["id"] as? Int ?? Int(viewId))",
      binaryMessenger: messenger
    )
    super.init()
    configureView()
  }

  func view() -> UIView { container }

  private func configureView() {
    container.overrideUserInterfaceStyle = isDark ? .dark : .light
    button.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(button)
    // Center vertically instead of pinning top+bottom: Flutter may size the
    // platform view taller than UIButton's intrinsic height (~44), and filling
    // both axes fights that constraint.
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      button.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      button.centerYAnchor.constraint(equalTo: container.centerYAnchor),
    ])
    button.addTarget(self, action: #selector(buttonTapped), for: .touchUpInside)
    button.isEnabled = isEnabled
    applyConfiguration()
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func applyConfiguration() {
    if #available(iOS 26.0, *) {
      var configuration = UIButton.Configuration.glass()
      configuration.cornerStyle = .capsule
      configuration.image = UIImage(
        systemName: sfSymbol,
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)
      )
      configuration.title = label
      configuration.imagePlacement = .top
      configuration.imagePadding = 3
      configuration.contentInsets = NSDirectionalEdgeInsets(
        top: 6, leading: 12, bottom: 6, trailing: 12
      )
      var attributedTitle = AttributedString(label)
      attributedTitle.font = .systemFont(ofSize: 11, weight: .semibold)
      configuration.attributedTitle = attributedTitle
      configuration.baseForegroundColor = foregroundColor
      button.configuration = configuration
    } else {
      var configuration = UIButton.Configuration.tinted()
      configuration.cornerStyle = .capsule
      configuration.image = UIImage(systemName: sfSymbol)
      configuration.title = label
      configuration.imagePlacement = .top
      configuration.imagePadding = 3
      configuration.baseForegroundColor = foregroundColor
      button.configuration = configuration
    }
    button.isEnabled = isEnabled
  }

  @objc private func buttonTapped() {
    channel.invokeMethod("pressed", arguments: nil)
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "setEnabled":
      if let args = call.arguments as? [String: Any],
        let enabled = args["enabled"] as? Bool
      {
        isEnabled = enabled
        button.isEnabled = enabled
      }
      result(nil)
    case "setColor":
      if let args = call.arguments as? [String: Any],
        let color = args["color"] as? Int
      {
        foregroundColor = UIColor(argb: color)
        applyConfiguration()
      }
      result(nil)
    case "setBrightness":
      if let args = call.arguments as? [String: Any],
        let dark = args["isDark"] as? Bool
      {
        isDark = dark
        container.overrideUserInterfaceStyle = dark ? .dark : .light
      }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}

// MARK: - iOS search field

private final class EcoMobileIOS26SearchFieldFactory: NSObject,
  FlutterPlatformViewFactory
{
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func create(
    withFrame frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?
  ) -> FlutterPlatformView {
    EcoMobileIOS26SearchField(
      frame: frame,
      viewIdentifier: viewId,
      arguments: args,
      binaryMessenger: messenger
    )
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}

/// System `UISearchBar` — unstyled so iOS 26 applies its own chrome.
///
/// Do not set `backgroundImage`, re-parent `searchTextField`, or force DIY
/// glass; those produce a custom look instead of the system search field.
private final class EcoMobileIOS26SearchField: NSObject, FlutterPlatformView,
  UISearchBarDelegate
{
  private let container: UIView
  private let searchBar: UISearchBar
  private let channel: FlutterMethodChannel
  private var isDark: Bool

  init(
    frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?,
    binaryMessenger messenger: FlutterBinaryMessenger
  ) {
    container = UIView(frame: frame)
    searchBar = UISearchBar()
    let config = args as? [String: Any] ?? [:]
    isDark = config["isDark"] as? Bool ?? false
    channel = FlutterMethodChannel(
      name: "eco_mobile/ios26_search_field_\(config["id"] as? Int ?? Int(viewId))",
      binaryMessenger: messenger
    )
    super.init()
    configureView(config: config)
  }

  func view() -> UIView { container }

  private func configureView(config: [String: Any]) {
    container.backgroundColor = .clear
    container.clipsToBounds = false
    container.overrideUserInterfaceStyle = isDark ? .dark : .light

    searchBar.translatesAutoresizingMaskIntoConstraints = false
    // System style only — leave materials / corner / fill to UIKit.
    searchBar.searchBarStyle = .minimal
    searchBar.placeholder = config["placeholder"] as? String ?? ""
    searchBar.autocapitalizationType = .none
    searchBar.autocorrectionType = .no
    searchBar.spellCheckingType = .no
    searchBar.returnKeyType = .search
    searchBar.enablesReturnKeyAutomatically = false
    searchBar.showsCancelButton = false
    searchBar.delegate = self

    container.addSubview(searchBar)
    NSLayoutConstraint.activate([
      searchBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      searchBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      searchBar.centerYAnchor.constraint(equalTo: container.centerYAnchor),
      searchBar.heightAnchor.constraint(equalTo: container.heightAnchor),
    ])

    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }

    if config["autofocus"] as? Bool == true {
      DispatchQueue.main.async { [weak self] in
        self?.searchBar.becomeFirstResponder()
      }
    }
  }

  func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
    channel.invokeMethod("onChanged", arguments: searchText)
  }

  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
    channel.invokeMethod("onSubmitted", arguments: searchBar.text ?? "")
    searchBar.resignFirstResponder()
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "setPlaceholder":
      if let args = call.arguments as? [String: Any],
        let placeholder = args["placeholder"] as? String
      {
        searchBar.placeholder = placeholder
      }
      result(nil)
    case "setText":
      if let args = call.arguments as? [String: Any],
        let text = args["text"] as? String
      {
        searchBar.text = text
        channel.invokeMethod("onChanged", arguments: text)
      }
      result(nil)
    case "setBrightness":
      if let args = call.arguments as? [String: Any],
        let dark = args["isDark"] as? Bool
      {
        isDark = dark
        container.overrideUserInterfaceStyle = dark ? .dark : .light
      }
      result(nil)
    case "focus":
      searchBar.becomeFirstResponder()
      result(nil)
    case "unfocus":
      searchBar.resignFirstResponder()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}

private extension UIColor {
  convenience init(argb: Int) {
    self.init(
      red: CGFloat((argb >> 16) & 0xFF) / 255,
      green: CGFloat((argb >> 8) & 0xFF) / 255,
      blue: CGFloat(argb & 0xFF) / 255,
      alpha: CGFloat((argb >> 24) & 0xFF) / 255
    )
  }
}
