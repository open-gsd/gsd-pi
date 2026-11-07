import Foundation
import ApplicationServices
import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - JSON Protocol Types

struct CommandRequest: Decodable {
    let command: String
    let params: [String: AnyCodable]?
}

struct CommandResponse: Encodable {
    let success: Bool
    let data: AnyCodable?
    let error: String?

    static func ok(_ data: Any) -> CommandResponse {
        CommandResponse(success: true, data: AnyCodable(data), error: nil)
    }

    static func fail(_ message: String) -> CommandResponse {
        CommandResponse(success: false, data: nil, error: message)
    }
}

/// Type-erased Codable wrapper for heterogeneous JSON values.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let a = try? container.decode([AnyCodable].self) {
            value = a.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let b as Bool:
            try container.encode(b)
        case let i as Int:
            try container.encode(i)
        case let i as Int64:
            try container.encode(i)
        case let i as Int32:
            try container.encode(i)
        case let i as UInt32:
            try container.encode(i)
        case let d as Double:
            try container.encode(d)
        case let s as String:
            try container.encode(s)
        case let a as [Any]:
            try container.encode(a.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encode(String(describing: value))
        }
    }
}

// MARK: - Debug Logging (stderr only)

func debug(_ message: String) {
    FileHandle.standardError.write(Data("[mac-agent] \(message)\n".utf8))
}

// MARK: - Command Handlers

func handlePing() -> CommandResponse {
    .ok(["status": "ok"])
}

func handleCheckPermissions() -> CommandResponse {
    let accessibilityEnabled = AXIsProcessTrusted()
    let screenRecordingEnabled = CGPreflightScreenCaptureAccess()
    return .ok([
        "accessibilityEnabled": accessibilityEnabled,
        "screenRecordingEnabled": screenRecordingEnabled
    ] as [String: Any])
}

// MARK: - App Lifecycle Commands

func handleListApps(_ params: [String: AnyCodable]?) -> CommandResponse {
    let includeBackground = (params?["includeBackground"]?.value as? Bool) ?? false
    let apps = NSWorkspace.shared.runningApplications

    var result: [[String: Any]] = []
    for app in apps {
        let policy = app.activationPolicy
        if policy == .regular || (includeBackground && policy == .accessory) {
            let entry: [String: Any] = [
                "name": app.localizedName ?? "Unknown",
                "bundleId": app.bundleIdentifier ?? "",
                "pid": Int(app.processIdentifier),
                "isActive": app.isActive
            ]
            result.append(entry)
        }
    }

    return .ok(result)
}

/// Find a running application by name or bundle ID.
func findRunningApp(params: [String: AnyCodable]?) -> NSRunningApplication? {
    let name = params?["name"]?.value as? String
    let bundleId = params?["bundleId"]?.value as? String

    guard name != nil || bundleId != nil else { return nil }

    let apps = NSWorkspace.shared.runningApplications
    for app in apps {
        if let bundleId = bundleId, app.bundleIdentifier == bundleId {
            return app
        }
        if let name = name, app.localizedName?.lowercased() == name.lowercased() {
            return app
        }
    }
    return nil
}

func handleLaunchApp(_ params: [String: AnyCodable]?) -> CommandResponse {
    let name = params?["name"]?.value as? String
    let bundleId = params?["bundleId"]?.value as? String

    guard name != nil || bundleId != nil else {
        return .fail("launchApp requires 'name' or 'bundleId' parameter")
    }

    // Try bundle ID first if provided
    if let bundleId = bundleId {
        if let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            do {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                let semaphore = DispatchSemaphore(value: 0)
                var launchedApp: NSRunningApplication?
                var launchError: Error?

                NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, error in
                    launchedApp = app
                    launchError = error
                    semaphore.signal()
                }
                semaphore.wait()

                if let error = launchError {
                    return .fail("Failed to launch app with bundleId '\(bundleId)': \(error.localizedDescription)")
                }

                return .ok([
                    "launched": true,
                    "name": launchedApp?.localizedName ?? "Unknown",
                    "bundleId": bundleId,
                    "pid": Int(launchedApp?.processIdentifier ?? 0)
                ] as [String: Any])
            }
        } else {
            return .fail("App not found with bundleId: \(bundleId)")
        }
    }

    // Launch by name using /usr/bin/open -a
    if let name = name {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", name]
        let errPipe = Pipe()
        process.standardError = errPipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return .fail("Failed to launch '\(name)': \(error.localizedDescription)")
        }

        if process.terminationStatus != 0 {
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            let errMsg = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown error"
            return .fail("App not found: \(name). \(errMsg)")
        }

        // Give the app a moment to appear in running apps, then find it
        Thread.sleep(forTimeInterval: 0.5)
        let apps = NSWorkspace.shared.runningApplications
        let launched = apps.first { $0.localizedName?.lowercased() == name.lowercased() }

        return .ok([
            "launched": true,
            "name": launched?.localizedName ?? name,
            "bundleId": launched?.bundleIdentifier ?? "",
            "pid": Int(launched?.processIdentifier ?? 0)
        ] as [String: Any])
    }

    return .fail("launchApp requires 'name' or 'bundleId' parameter")
}

func handleActivateApp(_ params: [String: AnyCodable]?) -> CommandResponse {
    let name = params?["name"]?.value as? String
    let bundleId = params?["bundleId"]?.value as? String

    guard name != nil || bundleId != nil else {
        return .fail("activateApp requires 'name' or 'bundleId' parameter")
    }

    guard let app = findRunningApp(params: params) else {
        let identifier = name ?? bundleId ?? "unknown"
        return .fail("App not running: \(identifier)")
    }

    let activated = app.activate(options: .activateIgnoringOtherApps)
    if activated {
        return .ok([
            "activated": true,
            "name": app.localizedName ?? "Unknown"
        ] as [String: Any])
    } else {
        return .fail("Failed to activate app: \(app.localizedName ?? "Unknown")")
    }
}

func handleQuitApp(_ params: [String: AnyCodable]?) -> CommandResponse {
    let name = params?["name"]?.value as? String
    let bundleId = params?["bundleId"]?.value as? String

    guard name != nil || bundleId != nil else {
        return .fail("quitApp requires 'name' or 'bundleId' parameter")
    }

    guard let app = findRunningApp(params: params) else {
        let identifier = name ?? bundleId ?? "unknown"
        return .fail("App not running: \(identifier)")
    }

    let appName = app.localizedName ?? "Unknown"
    let processIdentifier = Int(app.processIdentifier)
    guard processIdentifier > 0 else {
        return .fail("Unable to verify app process before quitting: \(appName)")
    }

    let terminationAccepted = app.terminate()
    guard terminationAccepted else {
        return .fail("Failed to quit app: \(appName). The app may have unsaved changes or refused to terminate.")
    }

    return .ok([
        "quit": true,
        "name": appName,
        "pid": processIdentifier
    ] as [String: Any])
}

// MARK: - AX Element Helpers

/// Resolve an `app` parameter (name or bundleId) to a running application.
func resolveApp(_ params: [String: AnyCodable]?) -> (app: NSRunningApplication?, identifier: String) {
    let appIdentifier = params?["app"]?.value as? String ?? ""
    guard !appIdentifier.isEmpty else { return (nil, "") }

    let apps = NSWorkspace.shared.runningApplications
    for app in apps {
        if app.bundleIdentifier == appIdentifier { return (app, appIdentifier) }
        if let name = app.localizedName, name.lowercased() == appIdentifier.lowercased() { return (app, appIdentifier) }
    }
    return (nil, appIdentifier)
}

/// Get child AXUIElements of a given element.
/// Uses AXUIElementCopyAttributeValues (plural, indexed) as primary path,
/// falling back to AXUIElementCopyAttributeValue for kAXChildrenAttribute.
/// Returns empty array on failure (leaf elements have no children — not an error).
func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    // Primary: AXUIElementCopyAttributeValues (plural) — handles edge cases in some apps
    var values: CFArray?
    let pluralErr = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 100, &values)
    if pluralErr == .success, let cfArray = values {
        let arr = cfArray as [AnyObject]
        return arr.compactMap { $0 as! AXUIElement? }
    }

    // Fallback: AXUIElementCopyAttributeValue (singular)
    var value: CFTypeRef?
    let singularErr = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    if singularErr == .success, let cfArray = value as? [AXUIElement] {
        return cfArray
    }

    return []
}

/// Extract key attributes from an AXUIElement as a dictionary.
/// Omits nil values. This is the standard element representation for JSON responses.
func getElementAttributes(_ element: AXUIElement) -> [String: Any] {
    var attrs: [String: Any] = [:]

    // Helper to read a string attribute
    func readString(_ attr: String) -> String? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success, let v = value else { return nil }
        return v as? String
    }

    // Helper to read a bool attribute
    func readBool(_ attr: String) -> Bool? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success, let v = value else { return nil }
        if let num = v as? NSNumber { return num.boolValue }
        return nil
    }

    if let role = readString(kAXRoleAttribute) { attrs["role"] = role }
    if let title = readString(kAXTitleAttribute) { attrs["title"] = title }
    if let desc = readString(kAXDescriptionAttribute) { attrs["description"] = desc }
    if let ident = readString("AXIdentifier") { attrs["identifier"] = ident }

    // AXValue: return string if it's a simple string, otherwise a type description
    var axValue: CFTypeRef?
    let valErr = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &axValue)
    if valErr == .success, let v = axValue {
        if let s = v as? String {
            attrs["value"] = s
        } else if let n = v as? NSNumber {
            attrs["value"] = n.stringValue
        } else {
            attrs["value"] = String(describing: type(of: v))
        }
    }

    if let enabled = readBool(kAXEnabledAttribute) { attrs["enabled"] = enabled }
    if let focused = readBool(kAXFocusedAttribute) { attrs["focused"] = focused }

    return attrs
}

/// DFS search for AXUIElements matching the given criteria.
/// Returns (matches, totalVisited, truncated).
func findMatchingElements(
    root: AXUIElement,
    role: String?,
    title: String?,
    value: String?,
    identifier: String?,
    matchType: String,
    maxDepth: Int,
    maxCount: Int
) -> (matches: [[String: Any]], totalVisited: Int, truncated: Bool) {
    var matches: [[String: Any]] = []
    var totalVisited = 0
    var truncated = false

    func matchesString(_ actual: String?, _ expected: String?, _ matchType: String) -> Bool {
        guard let expected = expected else { return true } // no criteria = matches
        guard let actual = actual else { return false }
        if matchType == "exact" {
            return actual == expected
        } else {
            // contains, case-insensitive
            return actual.lowercased().contains(expected.lowercased())
        }
    }

    func dfs(_ element: AXUIElement, depth: Int) {
        guard !truncated else { return }
        totalVisited += 1

        let attrs = getElementAttributes(element)
        let elementRole = attrs["role"] as? String
        let elementTitle = attrs["title"] as? String
        let elementValue = attrs["value"] as? String
        let elementIdent = attrs["identifier"] as? String

        // Check all specified criteria
        let roleMatch = matchesString(elementRole, role, matchType)
        let titleMatch = matchesString(elementTitle, title, matchType)
        let valueMatch = matchesString(elementValue, value, matchType)
        let identMatch = matchesString(elementIdent, identifier, matchType)

        // Only add if at least one criterion was specified and all specified criteria match
        let hasCriteria = role != nil || title != nil || value != nil || identifier != nil
        if !hasCriteria || (roleMatch && titleMatch && valueMatch && identMatch) {
            matches.append(attrs)
            if matches.count >= maxCount {
                truncated = true
                return
            }
        }

        // Recurse into children if within depth
        if depth < maxDepth {
            let children = getChildren(element)
            for child in children {
                guard !truncated else { return }
                dfs(child, depth: depth + 1)
            }
        }
    }

    dfs(root, depth: 0)
    return (matches, totalVisited, truncated)
}

// MARK: - Element Discovery Commands

func handleFindElements(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("findElements requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    let role = params?["role"]?.value as? String
    let title = params?["title"]?.value as? String
    let value = params?["value"]?.value as? String
    let identifierParam = params?["identifier"]?.value as? String
    let matchType = (params?["matchType"]?.value as? String) ?? "contains"

    let maxDepth: Int
    if let d = params?["maxDepth"]?.value as? Int { maxDepth = d }
    else if let d = params?["maxDepth"]?.value as? Double { maxDepth = Int(d) }
    else { maxDepth = 5 }

    let maxCount: Int
    if let c = params?["maxCount"]?.value as? Int { maxCount = c }
    else if let c = params?["maxCount"]?.value as? Double { maxCount = Int(c) }
    else { maxCount = 200 }

    let (matches, totalVisited, truncated) = findMatchingElements(
        root: appElement,
        role: role,
        title: title,
        value: value,
        identifier: identifierParam,
        matchType: matchType,
        maxDepth: maxDepth,
        maxCount: maxCount
    )

    return .ok([
        "elements": matches,
        "totalVisited": totalVisited,
        "truncated": truncated
    ] as [String: Any])
}

func handleGetTree(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("getTree requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    let maxDepth: Int
    if let d = params?["maxDepth"]?.value as? Int { maxDepth = d }
    else if let d = params?["maxDepth"]?.value as? Double { maxDepth = Int(d) }
    else { maxDepth = 5 }

    let maxCount: Int
    if let c = params?["maxCount"]?.value as? Int { maxCount = c }
    else if let c = params?["maxCount"]?.value as? Double { maxCount = Int(c) }
    else { maxCount = 200 }

    var totalElements = 0
    var truncated = false

    func buildTree(_ element: AXUIElement, depth: Int) -> [String: Any]? {
        guard !truncated else { return nil }
        totalElements += 1

        if totalElements > maxCount {
            truncated = true
            return nil
        }

        let attrs = getElementAttributes(element)
        var node: [String: Any] = [:]
        if let v = attrs["role"] { node["role"] = v }
        if let v = attrs["title"] { node["title"] = v }
        if let v = attrs["value"] { node["value"] = v }
        if let v = attrs["description"] { node["description"] = v }
        if let v = attrs["identifier"] { node["identifier"] = v }

        if depth < maxDepth {
            let children = getChildren(element)
            var childNodes: [[String: Any]] = []
            for child in children {
                guard !truncated else { break }
                if let childNode = buildTree(child, depth: depth + 1) {
                    childNodes.append(childNode)
                }
            }
            if !childNodes.isEmpty {
                node["children"] = childNodes
            }
        }

        return node
    }

    // Build tree from the app element's children (the app element itself is the root context)
    let rootChildren = getChildren(appElement)
    var tree: [[String: Any]] = []
    for child in rootChildren {
        guard !truncated else { break }
        if let node = buildTree(child, depth: 1) {
            tree.append(node)
        }
    }

    return .ok([
        "tree": tree,
        "totalElements": totalElements,
        "truncated": truncated
    ] as [String: Any])
}

// MARK: - AXValue Unpacking and Attribute Reading

/// Unpack an AXValue (CGPoint, CGSize, CGRect, CFRange) into a JSON-serializable dictionary.
/// Returns nil if the value is not an AXValue type.
func unpackAXValue(_ value: CFTypeRef) -> [String: Any]? {
    guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }

    let axValue = value as! AXValue
    let axType = AXValueGetType(axValue)

    switch axType {
    case .cgPoint:
        var point = CGPoint.zero
        if AXValueGetValue(axValue, .cgPoint, &point) {
            return ["type": "CGPoint", "x": Double(point.x), "y": Double(point.y)]
        }
    case .cgSize:
        var size = CGSize.zero
        if AXValueGetValue(axValue, .cgSize, &size) {
            return ["type": "CGSize", "width": Double(size.width), "height": Double(size.height)]
        }
    case .cgRect:
        var rect = CGRect.zero
        if AXValueGetValue(axValue, .cgRect, &rect) {
            return ["type": "CGRect", "x": Double(rect.origin.x), "y": Double(rect.origin.y),
                    "width": Double(rect.size.width), "height": Double(rect.size.height)]
        }
    case .cfRange:
        var range = CFRange(location: 0, length: 0)
        if AXValueGetValue(axValue, .cfRange, &range) {
            return ["type": "CFRange", "location": range.location, "length": range.length]
        }
    default:
        return ["type": "unknown", "description": String(describing: axType)]
    }

    return nil
}

/// Read a single attribute from an AXUIElement and return a JSON-serializable value.
/// Handles: NSString → String, NSNumber → Bool/Int/Double, AXValue → unpacked dict,
/// [AXUIElement] → count description, AXUIElement → role description.
func readElementAttribute(_ element: AXUIElement, attribute: String) -> Any? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard err == .success, let v = value else { return nil }

    // String
    if let s = v as? String { return s }

    // NSNumber — check for boolean first (CFBoolean is bridged to NSNumber)
    if let num = v as? NSNumber {
        if CFGetTypeID(num) == CFBooleanGetTypeID() {
            return num.boolValue
        }
        // Check if it's an integer (no fractional part)
        if num.doubleValue == Double(num.intValue) {
            return num.intValue
        }
        return num.doubleValue
    }

    // AXValue subtypes (CGPoint, CGSize, CGRect, CFRange)
    if let unpacked = unpackAXValue(v) {
        return unpacked
    }

    // Array of AXUIElements
    if let elements = v as? [AXUIElement] {
        return ["type": "elementArray", "count": elements.count]
    }

    // Single AXUIElement reference
    if CFGetTypeID(v) == AXUIElementGetTypeID() {
        let childElement = v as! AXUIElement
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(childElement, kAXRoleAttribute as CFString, &role)
        let roleStr = (role as? String) ?? "unknown"
        return ["type": "element", "role": roleStr]
    }

    // Fallback: string description
    return String(describing: v)
}

// MARK: - Interaction Commands

func handleClickElement(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("clickElement requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    let role = params?["role"]?.value as? String
    let title = params?["title"]?.value as? String
    let value = params?["value"]?.value as? String
    let identifierParam = params?["identifier"]?.value as? String
    let matchType = (params?["matchType"]?.value as? String) ?? "contains"

    guard role != nil || title != nil || value != nil || identifierParam != nil else {
        return .fail("clickElement requires at least one element criterion (role, title, value, or identifier)")
    }

    // Find the element using the shared DFS search, limit to 1 match
    let (matches, _, _) = findMatchingElements(
        root: appElement,
        role: role,
        title: title,
        value: value,
        identifier: identifierParam,
        matchType: matchType,
        maxDepth: 10,
        maxCount: 1
    )

    guard !matches.isEmpty else {
        var criteria: [String] = []
        if let r = role { criteria.append("role=\(r)") }
        if let t = title { criteria.append("title=\(t)") }
        if let v = value { criteria.append("value=\(v)") }
        if let i = identifierParam { criteria.append("identifier=\(i)") }
        return .fail("No element found matching criteria: \(criteria.joined(separator: ", ")) in app '\(identifier)'")
    }

    // We need the actual AXUIElement handle to perform the action
    let targetElement = findFirstAXUIElement(
        root: appElement,
        role: role,
        title: title,
        value: value,
        identifier: identifierParam,
        matchType: matchType,
        maxDepth: 10
    )

    guard let element = targetElement else {
        return .fail("Element found in search but could not re-acquire handle")
    }

    // Check available actions
    var actionNames: CFArray?
    AXUIElementCopyActionNames(element, &actionNames)
    let actions = (actionNames as? [String]) ?? []

    // Try AXPress
    let pressErr = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if pressErr == .success {
        // Read element attributes after click for post-action inspection
        let postAttrs = getElementAttributes(element)
        return .ok([
            "clicked": true,
            "element": postAttrs
        ] as [String: Any])
    }

    // AXPress failed — return actionable error with available actions
    return .fail("AXPress action failed (error \(pressErr.rawValue)) on element matching criteria. Available actions: \(actions.isEmpty ? "none" : actions.joined(separator: ", "))")
}

func handleTypeText(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("typeText requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    guard let text = params?["text"]?.value as? String else {
        return .fail("typeText requires 'text' parameter (string to type)")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    let role = params?["role"]?.value as? String
    let title = params?["title"]?.value as? String
    let value = params?["value"]?.value as? String
    let identifierParam = params?["identifier"]?.value as? String
    let matchType = (params?["matchType"]?.value as? String) ?? "contains"

    guard role != nil || title != nil || value != nil || identifierParam != nil else {
        return .fail("typeText requires at least one element criterion (role, title, value, or identifier)")
    }

    let targetElement = findFirstAXUIElement(
        root: appElement,
        role: role,
        title: title,
        value: value,
        identifier: identifierParam,
        matchType: matchType,
        maxDepth: 10
    )

    guard let element = targetElement else {
        var criteria: [String] = []
        if let r = role { criteria.append("role=\(r)") }
        if let t = title { criteria.append("title=\(t)") }
        if let v = value { criteria.append("value=\(v)") }
        if let i = identifierParam { criteria.append("identifier=\(i)") }
        return .fail("No element found matching criteria: \(criteria.joined(separator: ", ")) in app '\(identifier)'")
    }

    // Set the AXValue attribute
    let setErr = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
    if setErr != .success {
        return .fail("Failed to set AXValue on element (error \(setErr.rawValue)). The element may be read-only or not support text input.")
    }

    // Read back the value for verification
    var readBack: CFTypeRef?
    let readErr = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &readBack)
    let readValue: Any
    if readErr == .success, let v = readBack {
        if let s = v as? String { readValue = s }
        else if let n = v as? NSNumber { readValue = n.stringValue }
        else { readValue = String(describing: v) }
    } else {
        readValue = NSNull()
    }

    let elementAttrs = getElementAttributes(element)
    return .ok([
        "typed": true,
        "value": readValue,
        "element": elementAttrs
    ] as [String: Any])
}

func handleReadAttribute(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("readAttribute requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    // Support single "attribute" or multiple "attributes"
    let singleAttr = params?["attribute"]?.value as? String
    var multiAttrs: [String]? = nil
    if let arr = params?["attributes"]?.value as? [Any] {
        multiAttrs = arr.compactMap { $0 as? String }
    }

    guard singleAttr != nil || (multiAttrs != nil && !multiAttrs!.isEmpty) else {
        return .fail("readAttribute requires 'attribute' (string) or 'attributes' (array of strings) parameter")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    let role = params?["role"]?.value as? String
    let title = params?["title"]?.value as? String
    let value = params?["value"]?.value as? String
    let identifierParam = params?["identifier"]?.value as? String
    let matchType = (params?["matchType"]?.value as? String) ?? "contains"

    guard role != nil || title != nil || value != nil || identifierParam != nil else {
        return .fail("readAttribute requires at least one element criterion (role, title, value, or identifier)")
    }

    let targetElement = findFirstAXUIElement(
        root: appElement,
        role: role,
        title: title,
        value: value,
        identifier: identifierParam,
        matchType: matchType,
        maxDepth: 10
    )

    guard let element = targetElement else {
        var criteria: [String] = []
        if let r = role { criteria.append("role=\(r)") }
        if let t = title { criteria.append("title=\(t)") }
        if let v = value { criteria.append("value=\(v)") }
        if let i = identifierParam { criteria.append("identifier=\(i)") }
        return .fail("No element found matching criteria: \(criteria.joined(separator: ", ")) in app '\(identifier)'")
    }

    let elementAttrs = getElementAttributes(element)

    // Single attribute mode
    if let attr = singleAttr {
        let val = readElementAttribute(element, attribute: attr)
        return .ok([
            "value": val ?? NSNull(),
            "element": elementAttrs
        ] as [String: Any])
    }

    // Multiple attributes mode
    if let attrs = multiAttrs {
        var values: [String: Any] = [:]
        for attr in attrs {
            values[attr] = readElementAttribute(element, attribute: attr) ?? NSNull()
        }
        return .ok([
            "values": values,
            "element": elementAttrs
        ] as [String: Any])
    }

    return .fail("Internal error: no attribute specified")
}

func handleGetFocusedElement(_ params: [String: AnyCodable]?) -> CommandResponse {
    let (app, identifier) = resolveApp(params)

    guard !identifier.isEmpty else {
        return .fail("getFocusedElement requires 'app' parameter (app name or bundleId)")
    }
    guard let app = app else {
        return .fail("App not running: \(identifier)")
    }

    let pid = app.processIdentifier
    let appElement = AXUIElementCreateApplication(pid)

    // Attempt to get the focused element
    var focusedValue: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &focusedValue)

    if err == .success, let focused = focusedValue {
        // If it works (unlikely from CLI context), return element attributes
        if CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let focusedElement = focused as! AXUIElement
            let attrs = getElementAttributes(focusedElement)
            return .ok([
                "focused": true,
                "element": attrs
            ] as [String: Any])
        }
        return .ok(["focused": true, "value": String(describing: focused)])
    }

    // Expected failure from CLI context — return actionable error
    return .fail("getFocusedElement failed (AX error \(err.rawValue)). " +
        "This is a known macOS limitation: kAXFocusedUIElementAttribute returns error -25212 (notImplemented) " +
        "when called from a CLI process that is not the frontmost app. " +
        "Workaround: use findElements with role/title criteria to locate specific elements, " +
        "or use getTree to discover the element hierarchy.")
}

/// Find the first AXUIElement matching the given criteria via DFS.
/// Returns the AXUIElement handle (not just attributes) for performing actions.
func findFirstAXUIElement(
    root: AXUIElement,
    role: String?,
    title: String?,
    value: String?,
    identifier: String?,
    matchType: String,
    maxDepth: Int
) -> AXUIElement? {
    func matchesString(_ actual: String?, _ expected: String?, _ matchType: String) -> Bool {
        guard let expected = expected else { return true }
        guard let actual = actual else { return false }
        if matchType == "exact" {
            return actual == expected
        } else {
            return actual.lowercased().contains(expected.lowercased())
        }
    }

    func dfs(_ element: AXUIElement, depth: Int) -> AXUIElement? {
        let attrs = getElementAttributes(element)
        let elementRole = attrs["role"] as? String
        let elementTitle = attrs["title"] as? String
        let elementValue = attrs["value"] as? String
        let elementIdent = attrs["identifier"] as? String

        let roleMatch = matchesString(elementRole, role, matchType)
        let titleMatch = matchesString(elementTitle, title, matchType)
        let valueMatch = matchesString(elementValue, value, matchType)
        let identMatch = matchesString(elementIdent, identifier, matchType)

        let hasCriteria = role != nil || title != nil || value != nil || identifier != nil
        if hasCriteria && roleMatch && titleMatch && valueMatch && identMatch {
            return element
        }

        if depth < maxDepth {
            for child in getChildren(element) {
                if let found = dfs(child, depth: depth + 1) {
                    return found
                }
            }
        }

        return nil
    }

    return dfs(root, depth: 0)
}

// MARK: - Window Commands

func handleListWindows(_ params: [String: AnyCodable]?) -> CommandResponse {
    let appIdentifier = params?["app"]?.value as? String

    guard let appIdentifier = appIdentifier, !appIdentifier.isEmpty else {
        return .fail("listWindows requires 'app' parameter (app name or bundleId)")
    }

    // Resolve app to PID
    let apps = NSWorkspace.shared.runningApplications
    var targetApp: NSRunningApplication?
    for app in apps {
        if app.bundleIdentifier == appIdentifier {
            targetApp = app
            break
        }
        if let name = app.localizedName, name.lowercased() == appIdentifier.lowercased() {
            targetApp = app
            break
        }
    }

    guard let app = targetApp else {
        return .fail("App not running: \(appIdentifier)")
    }

    let targetPid = Int(app.processIdentifier)

    // Get on-screen windows via CGWindowListCopyWindowInfo
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return .ok(["windows": [] as [Any], "app": app.localizedName ?? appIdentifier, "pid": targetPid])
    }

    var windows: [[String: Any]] = []
    for win in windowList {
        guard let ownerPid = win[kCGWindowOwnerPID as String] as? Int,
              ownerPid == targetPid else { continue }

        // Skip windows with no title or empty title that are at layer 0
        // (these are often AXScrollArea-type artifacts, e.g. Finder desktop)
        let title = win[kCGWindowName as String] as? String ?? ""
        let layer = win[kCGWindowLayer as String] as? Int ?? 0
        let windowId = win[kCGWindowNumber as String] as? Int ?? 0
        let isOnScreen = win[kCGWindowIsOnscreen as String] as? Bool ?? true

        // Get bounds
        var bounds: [String: Any] = [:]
        if let boundsDict = win[kCGWindowBounds as String] as? [String: Any] {
            bounds = [
                "x": boundsDict["X"] as? Double ?? 0.0,
                "y": boundsDict["Y"] as? Double ?? 0.0,
                "width": boundsDict["Width"] as? Double ?? 0.0,
                "height": boundsDict["Height"] as? Double ?? 0.0
            ]
        }

        let entry: [String: Any] = [
            "windowId": windowId,
            "title": title,
            "bounds": bounds,
            "isOnScreen": isOnScreen,
            "layer": layer
        ]
        windows.append(entry)
    }

    return .ok(["windows": windows, "app": app.localizedName ?? appIdentifier, "pid": targetPid] as [String: Any])
}

func handleGetWindowInfo(_ params: [String: AnyCodable]?) -> CommandResponse {
    let windowIdValue = params?["windowId"]?.value
    let windowId: Int

    // Handle both Int and Double (JSON numbers can decode as either)
    if let intVal = windowIdValue as? Int {
        windowId = intVal
    } else if let doubleVal = windowIdValue as? Double {
        windowId = Int(doubleVal)
    } else {
        return .fail("getWindowInfo requires 'windowId' parameter (number)")
    }

    // Get all windows including off-screen
    guard let windowList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
        return .fail("Failed to retrieve window list from CGWindowListCopyWindowInfo")
    }

    for win in windowList {
        guard let winNum = win[kCGWindowNumber as String] as? Int,
              winNum == windowId else { continue }

        let title = win[kCGWindowName as String] as? String ?? ""
        let ownerName = win[kCGWindowOwnerName as String] as? String ?? ""
        let ownerPid = win[kCGWindowOwnerPID as String] as? Int ?? 0
        let layer = win[kCGWindowLayer as String] as? Int ?? 0
        let isOnScreen = win[kCGWindowIsOnscreen as String] as? Bool ?? false
        let alpha = win[kCGWindowAlpha as String] as? Double ?? 1.0
        let memoryUsage = win[kCGWindowMemoryUsage as String] as? Int ?? 0

        var bounds: [String: Any] = [:]
        if let boundsDict = win[kCGWindowBounds as String] as? [String: Any] {
            bounds = [
                "x": boundsDict["X"] as? Double ?? 0.0,
                "y": boundsDict["Y"] as? Double ?? 0.0,
                "width": boundsDict["Width"] as? Double ?? 0.0,
                "height": boundsDict["Height"] as? Double ?? 0.0
            ]
        }

        let result: [String: Any] = [
            "windowId": windowId,
            "title": title,
            "bounds": bounds,
            "ownerName": ownerName,
            "ownerPid": ownerPid,
            "layer": layer,
            "isOnScreen": isOnScreen,
            "alpha": alpha,
            "memoryUsage": memoryUsage
        ]
        return .ok(result)
    }

    return .fail("Window not found: \(windowId)")
}

// MARK: - Screenshot Commands

func handleScreenshotWindow(_ params: [String: AnyCodable]?) -> CommandResponse {
    // Check Screen Recording permission first
    guard CGPreflightScreenCaptureAccess() else {
        return .fail("Screen Recording permission not granted. " +
            "Go to System Settings → Privacy & Security → Screen Recording and enable this app. " +
            "You may need to add the terminal or shell that runs mac-agent.")
    }

    // Parse windowId (handle both Int and Double from JSON)
    let windowIdValue = params?["windowId"]?.value
    let windowId: UInt32

    if let intVal = windowIdValue as? Int {
        windowId = UInt32(intVal)
    } else if let doubleVal = windowIdValue as? Double {
        windowId = UInt32(doubleVal)
    } else {
        return .fail("screenshotWindow requires 'windowId' parameter (number)")
    }

    // Parse optional parameters
    let format = (params?["format"]?.value as? String) ?? "jpeg"
    let quality: Double
    if let q = params?["quality"]?.value as? Double {
        quality = q
    } else {
        quality = 0.8
    }
    let retina = (params?["retina"]?.value as? Bool) ?? false

    guard format == "jpeg" || format == "png" else {
        return .fail("Unsupported format '\(format)'. Use 'jpeg' or 'png'.")
    }

    debug("screenshotWindow: windowId=\(windowId) format=\(format) quality=\(quality) retina=\(retina)")

    // Get available windows via SCShareableContent
    let semaphore = DispatchSemaphore(value: 0)
    var scContent: SCShareableContent?
    var scError: Error?

    Task {
        do {
            scContent = try await SCShareableContent.current
        } catch {
            scError = error
        }
        semaphore.signal()
    }
    semaphore.wait()

    if let error = scError {
        return .fail("Failed to get shareable content: \(error.localizedDescription)")
    }

    guard let content = scContent else {
        return .fail("SCShareableContent returned nil")
    }

    // Find the window matching windowId
    guard let targetWindow = content.windows.first(where: { $0.windowID == windowId }) else {
        debug("screenshotWindow: Window not found. Available window IDs: \(content.windows.prefix(20).map { $0.windowID })")
        return .fail("Window not found with ID \(windowId). Use 'listWindows' to get valid window IDs.")
    }

    debug("screenshotWindow: Found window '\(targetWindow.title ?? "untitled")' (\(targetWindow.frame.width)x\(targetWindow.frame.height))")

    // Configure capture
    let config = SCStreamConfiguration()
    config.captureResolution = retina ? .best : .nominal
    // Set dimensions to match the window frame
    config.width = Int(targetWindow.frame.width)
    config.height = Int(targetWindow.frame.height)

    // Capture the image
    let captureSemaphore = DispatchSemaphore(value: 0)
    var capturedImage: CGImage?
    var captureError: Error?

    let captureStart = CFAbsoluteTimeGetCurrent()

    Task {
        do {
            capturedImage = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: targetWindow),
                configuration: config
            )
        } catch {
            captureError = error
        }
        captureSemaphore.signal()
    }
    captureSemaphore.wait()

    let captureDuration = CFAbsoluteTimeGetCurrent() - captureStart
    debug("screenshotWindow: Capture took \(String(format: "%.3f", captureDuration))s")

    if let error = captureError {
        return .fail("Screenshot capture failed: \(error.localizedDescription)")
    }

    guard let image = capturedImage else {
        return .fail("Screenshot capture returned nil image for window \(windowId)")
    }

    let imageWidth = image.width
    let imageHeight = image.height
    debug("screenshotWindow: Captured image \(imageWidth)x\(imageHeight)")

    // Encode to JPEG or PNG using CGImageDestination
    let imageData = NSMutableData()
    let uti = (format == "png") ? UTType.png.identifier as CFString : UTType.jpeg.identifier as CFString

    guard let destination = CGImageDestinationCreateWithData(imageData as CFMutableData, uti, 1, nil) else {
        return .fail("Failed to create image destination for encoding")
    }

    var options: [CFString: Any] = [:]
    if format == "jpeg" {
        options[kCGImageDestinationLossyCompressionQuality] = quality
    }

    CGImageDestinationAddImage(destination, image, options as CFDictionary)

    guard CGImageDestinationFinalize(destination) else {
        return .fail("Failed to encode image to \(format)")
    }

    // Base64 encode
    let base64String = (imageData as Data).base64EncodedString()
    debug("screenshotWindow: Encoded \(format) data size: \(base64String.count) chars (\(imageData.length) bytes raw)")

    return .ok([
        "imageData": base64String,
        "format": format,
        "width": imageWidth,
        "height": imageHeight
    ] as [String: Any])
}

// MARK: - Command Dispatch

func dispatch(_ request: CommandRequest) -> CommandResponse {
    debug("Dispatching command: \(request.command)")

    switch request.command {
    case "ping":
        return handlePing()
    case "checkPermissions":
        return handleCheckPermissions()
    case "listApps":
        return handleListApps(request.params)
    case "launchApp":
        return handleLaunchApp(request.params)
    case "activateApp":
        return handleActivateApp(request.params)
    case "quitApp":
        return handleQuitApp(request.params)
    case "listWindows":
        return handleListWindows(request.params)
    case "getWindowInfo":
        return handleGetWindowInfo(request.params)
    case "screenshotWindow":
        return handleScreenshotWindow(request.params)
    case "findElements":
        return handleFindElements(request.params)
    case "getTree":
        return handleGetTree(request.params)
    case "clickElement":
        return handleClickElement(request.params)
    case "typeText":
        return handleTypeText(request.params)
    case "readAttribute":
        return handleReadAttribute(request.params)
    case "getFocusedElement":
        return handleGetFocusedElement(request.params)
    default:
        return .fail("Unknown command: \(request.command)")
    }
}

// MARK: - Main Entry Point

func main() {
    // Initialize NSApplication — required for ScreenCaptureKit's WindowServer connection.
    // Must happen before any SCShareableContent or SCScreenshotManager calls.
    // Verified to not break JSON stdin/stdout protocol.
    let _ = NSApplication.shared

    // Read all of stdin
    let inputData = FileHandle.standardInput.readDataToEndOfFile()

    guard !inputData.isEmpty else {
        let response = CommandResponse.fail("No input received on stdin")
        writeResponse(response)
        return
    }

    // Parse the command request
    let decoder = JSONDecoder()
    let request: CommandRequest
    do {
        request = try decoder.decode(CommandRequest.self, from: inputData)
    } catch {
        let response = CommandResponse.fail("Invalid JSON input: \(error.localizedDescription)")
        writeResponse(response)
        return
    }

    // Dispatch and respond
    let response = dispatch(request)
    writeResponse(response)
}

func writeResponse(_ response: CommandResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    do {
        let data = try encoder.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        // Last-resort fallback — write error JSON manually
        let fallback = #"{"success":false,"error":"Failed to encode response: \#(error.localizedDescription)"}"#
        FileHandle.standardOutput.write(Data(fallback.utf8))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

main()
