import CryptoKit
import Foundation
import Security

// A deliberately small, standalone macOS signer. The model-facing MCP never receives a private key
// or supplies a digest to this process. Only protocol-defined authentication objects reach Secure Enclave.

private enum SignerError: Error, CustomStringConvertible {
    case invalid(String)
    case keychain(OSStatus)
    var description: String {
        switch self {
        case .invalid(let message): return message
        case .keychain(let status): return "Keychain operation failed (\(status))"
        }
    }
}

private func bytes(hex: String, length: Int? = nil) throws -> [UInt8] {
    let value = hex.hasPrefix("0x") ? String(hex.dropFirst(2)) : hex
    guard value.count % 2 == 0, value.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57 || $0 >= 65 && $0 <= 70 || $0 >= 97 && $0 <= 102) }) else {
        throw SignerError.invalid("Invalid hexadecimal value")
    }
    if let length, value.count != length * 2 { throw SignerError.invalid("Incorrect hex length") }
    var output: [UInt8] = []
    output.reserveCapacity(value.count / 2)
    var index = value.startIndex
    while index < value.endIndex {
        let next = value.index(index, offsetBy: 2)
        output.append(UInt8(value[index..<next], radix: 16)!)
        index = next
    }
    return output
}

private func hex(_ value: [UInt8]) -> String {
    "0x" + value.map { String(format: "%02x", $0) }.joined()
}

private let rotations: [Int] = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
    41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]
private let roundConstants: [UInt64] = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
    0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

private func rotate(_ value: UInt64, _ count: Int) -> UInt64 {
    count == 0 ? value : (value << count) | (value >> (64 - count))
}

private func keccakF(_ state: inout [UInt64]) {
    for constant in roundConstants {
        var c = [UInt64](repeating: 0, count: 5)
        for x in 0..<5 { for y in 0..<5 { c[x] ^= state[x + 5 * y] } }
        for x in 0..<5 {
            let d = c[(x + 4) % 5] ^ rotate(c[(x + 1) % 5], 1)
            for y in 0..<5 { state[x + 5 * y] ^= d }
        }
        var b = [UInt64](repeating: 0, count: 25)
        for x in 0..<5 { for y in 0..<5 {
            let source = x + 5 * y
            b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[source], rotations[source])
        } }
        for x in 0..<5 { for y in 0..<5 {
            state[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y])
        } }
        state[0] ^= constant
    }
}

private func keccak256(_ message: [UInt8]) -> [UInt8] {
    let rate = 136
    var input = message
    input.append(0x01) // Ethereum Keccak domain, not standardized SHA3 domain 0x06.
    while input.count % rate != rate - 1 { input.append(0) }
    input.append(0x80)
    var state = [UInt64](repeating: 0, count: 25)
    for start in stride(from: 0, to: input.count, by: rate) {
        for offset in 0..<rate {
            state[offset / 8] ^= UInt64(input[start + offset]) << (8 * (offset % 8))
        }
        keccakF(&state)
    }
    return (0..<32).map { UInt8(truncatingIfNeeded: state[$0 / 8] >> (8 * ($0 % 8))) }
}

private func word(_ value: UInt64) -> [UInt8] {
    [UInt8](repeating: 0, count: 24) + (0..<8).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
}

private func stringHash(_ value: String) -> [UInt8] { keccak256(Array(value.utf8)) }

private struct Request: Decodable {
    let kind: String
    let label: String
    let agentId: String
    let chainId: UInt64
    let audience: String
    let method: String
    let target: String
    let bodyBase64: String
}

private struct Challenge: Codable {
    let agentId: String
    let audience: String
    let chainId: UInt64
    let nonce: String
    let issuedAt: UInt64
    let expiresAt: UInt64
}

private struct ChallengeRequest: Decodable {
    let kind: String
    let label: String
    let challenge: Challenge
}

private func canonicalAudience(_ audience: String) throws {
    guard let components = URLComponents(string: audience), components.scheme == "https",
          let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
          components.path.isEmpty, components.query == nil, components.fragment == nil,
          components.url?.originString == audience else {
        throw SignerError.invalid("Audience must be a canonical HTTPS origin")
    }
}

private extension URL {
    var originString: String {
        let portPart = port.map { ":\($0)" } ?? ""
        let hostPart = host.map { $0.contains(":") ? "[\($0)]" : $0 } ?? ""
        return "\(scheme ?? "")://\(hostPart)\(portPart)"
    }
}

private func digest(_ request: Request, nonce: [UInt8], issuedAt: UInt64, expiresAt: UInt64) throws -> (hash: [UInt8], bodyHash: [UInt8]) {
    guard request.kind == "AgentRequest" else { throw SignerError.invalid("Unsupported signing request type") }
    guard request.chainId > 0 else { throw SignerError.invalid("Invalid chain ID") }
    try canonicalAudience(request.audience)
    guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(request.method) else { throw SignerError.invalid("Unsupported method") }
    guard request.target.hasPrefix("/"), !request.target.hasPrefix("//"),
          !request.target.contains("#"), !request.target.contains("\\"),
          !request.target.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) else {
        throw SignerError.invalid("Invalid origin-form target")
    }
    guard let body = Data(base64Encoded: request.bodyBase64), body.count <= 65_536 else { throw SignerError.invalid("Invalid or oversized body") }
    if request.method == "GET" && !body.isEmpty { throw SignerError.invalid("GET cannot have a body") }
    let agent = try bytes(hex: request.agentId, length: 20)
    guard agent.contains(where: { $0 != 0 }) else { throw SignerError.invalid("Zero agent ID") }
    let paddedAgent = [UInt8](repeating: 0, count: 12) + agent
    let domainType = stringHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    let requestType = stringHash("AgentRequest(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash)")
    let domain = keccak256(domainType + stringHash("Agentic World AgentAccount") + stringHash("1") + word(request.chainId) + paddedAgent)
    let bodyHash = keccak256(Array(body))
    let structHash = keccak256(requestType + paddedAgent + stringHash(request.audience) + nonce + word(issuedAt) + word(expiresAt)
        + stringHash(request.method) + stringHash(request.target) + bodyHash)
    return (keccak256([0x19, 0x01] + domain + structHash), bodyHash)
}

private func challengeDigest(_ request: ChallengeRequest, enforceTime: Bool = true) throws -> [UInt8] {
    guard request.kind == "AgentAuthentication" else { throw SignerError.invalid("Unsupported signing request type") }
    let challenge = request.challenge
    guard challenge.chainId > 0 else { throw SignerError.invalid("Invalid chain ID") }
    try canonicalAudience(challenge.audience)
    let now = UInt64(Date().timeIntervalSince1970)
    if enforceTime {
        guard challenge.issuedAt <= now + 30, challenge.expiresAt > now,
              challenge.expiresAt > challenge.issuedAt,
              challenge.expiresAt - challenge.issuedAt <= 300 else {
            throw SignerError.invalid("Challenge is expired or outside the accepted time window")
        }
    }
    let agent = try bytes(hex: challenge.agentId, length: 20)
    guard agent.contains(where: { $0 != 0 }) else { throw SignerError.invalid("Zero agent ID") }
    let paddedAgent = [UInt8](repeating: 0, count: 12) + agent
    let nonce = try bytes(hex: challenge.nonce, length: 32)
    let domainType = stringHash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    let authType = stringHash("AgentAuthentication(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)")
    let domain = keccak256(domainType + stringHash("Agentic World AgentAccount") + stringHash("1")
        + word(challenge.chainId) + paddedAgent)
    let structHash = keccak256(authType + paddedAgent + stringHash(challenge.audience) + nonce
        + word(challenge.issuedAt) + word(challenge.expiresAt))
    return keccak256([0x19, 0x01] + domain + structHash)
}

private let keychainService = "world.agentic.secure-enclave.signer"

private func saveKeyReference(_ label: String, _ reference: Data) throws {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: label, kSecValueData as String: reference,
                                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw SignerError.keychain(status) }
}

private func loadKeyReference(_ label: String) throws -> Data {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: label, kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else { throw SignerError.keychain(status) }
    return data
}

private func keyReferenceExists(_ label: String) throws -> Bool {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: label, kSecMatchLimit as String: kSecMatchLimitOne]
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess else { throw SignerError.keychain(status) }
    return true
}

private func publicKey(_ key: SecureEnclave.P256.Signing.PrivateKey) -> [UInt8] {
    Array(key.publicKey.x963Representation)
}

private let p256Order = try! bytes(hex: "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", length: 32)
private let p256HalfOrder = try! bytes(hex: "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8", length: 32)

private func lowSSignature(_ signature: [UInt8]) throws -> [UInt8] {
    guard signature.count == 64 else { throw SignerError.invalid("Invalid Secure Enclave signature") }
    let s = Array(signature[32..<64])
    if !s.lexicographicallyPrecedes(p256HalfOrder) && s != p256HalfOrder {
        var adjusted = [UInt8](repeating: 0, count: 32)
        var borrow = 0
        for index in (0..<32).reversed() {
            var difference = Int(p256Order[index]) - Int(s[index]) - borrow
            borrow = difference < 0 ? 1 : 0
            if difference < 0 { difference += 256 }
            adjusted[index] = UInt8(difference)
        }
        return Array(signature[0..<32]) + adjusted
    }
    return signature
}

private struct RawDigest: Digest {
    static let byteCount = 32
    let value: [UInt8]
    var description: String { hex(value) }
    func makeIterator() -> IndexingIterator<[UInt8]> { value.makeIterator() }
    func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try value.withUnsafeBytes(body)
    }
}

private func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([0x0a]))
}

private func run() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else { throw SignerError.invalid("Expected provision, public-key, sign-challenge, sign-request, or hash") }
    if arguments[1] == "self-test" {
        guard arguments.count == 2 else { throw SignerError.invalid("self-test takes no arguments") }
        let request = Request(kind: "AgentRequest", label: "test", agentId: "0x1111111111111111111111111111111111111111",
                              chainId: 31337, audience: "https://service-a.example", method: "POST",
                              target: "/report?format=json", bodyBase64: Data("{\"ok\":true}".utf8).base64EncodedString())
        let computed = try digest(request, nonce: [UInt8](repeating: 0x22, count: 32), issuedAt: 1_700_000_000, expiresAt: 1_700_000_060)
        guard hex(computed.hash) == "0xa3a2724afd21df5edf29f4edcff382d9ea174b87a8c505584b5f12ab141e1e3d",
              hex(computed.bodyHash) == "0xaf7220891333e24ced1fcd91362b60dd07458c77d6658c92e4306e08eb7a8317" else {
            throw SignerError.invalid("EIP-712 self-test failed")
        }
        let challenge = Challenge(agentId: "0x1111111111111111111111111111111111111111",
                                  audience: "https://service-a.example", chainId: 31337,
                                  nonce: "0x" + String(repeating: "22", count: 32),
                                  issuedAt: 1_700_000_000, expiresAt: 1_700_000_060)
        let challengeHash = try challengeDigest(ChallengeRequest(kind: "AgentAuthentication", label: "test",
                                                                 challenge: challenge), enforceTime: false)
        guard hex(challengeHash) == "0xcc0a62bbb07f2774ff53282919ef91ec302742394a18a42d0fb7cfacb6341e65" else {
            throw SignerError.invalid("AgentAuthentication self-test failed")
        }
        try output(["ok": true, "requestDigest": hex(computed.hash), "challengeDigest": hex(challengeHash)])
        return
    }
    if arguments[1] == "availability" {
        guard arguments.count == 2 else { throw SignerError.invalid("availability takes no arguments") }
        try output(["secureEnclaveAvailable": SecureEnclave.isAvailable])
        return
    }
    if arguments[1] == "hash" {
        guard arguments.count == 3 else { throw SignerError.invalid("Expected one hex message") }
        try output(["hash": hex(keccak256(try bytes(hex: arguments[2])))])
        return
    }
    guard arguments.count == 3, !arguments[2].isEmpty, arguments[2].utf8.count <= 128 else {
        throw SignerError.invalid("Expected a key label (1–128 bytes)")
    }
    let label = arguments[2]
    if arguments[1] == "provision" {
        guard SecureEnclave.isAvailable else { throw SignerError.invalid("Secure Enclave is unavailable on this Mac") }
        guard try !keyReferenceExists(label) else { throw SignerError.invalid("Key label already exists") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage], &error) else { throw error!.takeRetainedValue() as Error }
        let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
        try saveKeyReference(label, key.dataRepresentation)
        let publicBytes = publicKey(key)
        try output(["scheme": "p256", "qx": hex(Array(publicBytes[1..<33])), "qy": hex(Array(publicBytes[33..<65]))])
        return
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: loadKeyReference(label))
    if arguments[1] == "public-key" {
        let publicBytes = publicKey(key)
        try output(["scheme": "p256", "qx": hex(Array(publicBytes[1..<33])), "qy": hex(Array(publicBytes[33..<65]))])
        return
    }
    if arguments[1] == "sign-challenge" {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count <= 4096 else { throw SignerError.invalid("Challenge too large") }
        let request = try JSONDecoder().decode(ChallengeRequest.self, from: input)
        guard request.label == label else { throw SignerError.invalid("Key label mismatch") }
        let hash = try challengeDigest(request)
        let raw = try key.signature(for: RawDigest(value: hash)).rawRepresentation
        let signature = try lowSSignature(Array(raw))
        let challenge = request.challenge
        try output(["agentId": challenge.agentId, "audience": challenge.audience,
                    "chainId": challenge.chainId, "nonce": challenge.nonce,
                    "issuedAt": challenge.issuedAt, "expiresAt": challenge.expiresAt,
                    "signature": hex(signature)])
        return
    }
    guard arguments[1] == "sign-request" else { throw SignerError.invalid("Unsupported command") }
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 100_000 else { throw SignerError.invalid("Request too large") }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard request.label == label else { throw SignerError.invalid("Key label mismatch") }
    var nonce = [UInt8](repeating: 0, count: 32)
    let randomStatus = nonce.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard randomStatus == errSecSuccess else {
        throw SignerError.invalid("Secure random generation failed")
    }
    let issuedAt = UInt64(Date().timeIntervalSince1970)
    let expiresAt = issuedAt + 60
    let computed = try digest(request, nonce: nonce, issuedAt: issuedAt, expiresAt: expiresAt)
    let raw = try key.signature(for: RawDigest(value: computed.hash)).rawRepresentation
    let signature = try lowSSignature(Array(raw))
    try output(["agentId": request.agentId, "audience": request.audience, "chainId": request.chainId,
                "nonce": hex(nonce), "issuedAt": issuedAt, "expiresAt": expiresAt,
                "method": request.method, "target": request.target, "bodyHash": hex(computed.bodyHash),
                "signature": hex(signature)])
}

do { try run() }
catch {
    FileHandle.standardError.write(Data("Agentic signer: \(error)\n".utf8))
    exit(1)
}
