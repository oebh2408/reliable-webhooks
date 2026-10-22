import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Address ranges a webhook should never reach when endpoint URLs come from
 * users: loopback, private networks, link-local (including cloud metadata
 * addresses), carrier-grade NAT, multicast and reserved ranges.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for addresses in private, loopback, link-local and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family !== 6) return false;
  // IPv4 inside IPv6: ::ffff:10.0.0.1 (mapped) and 64:ff9b::10.0.0.1 (NAT64).
  const embedded = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) return blocked.check(embedded, "ipv4");
  const hex = ip.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
  }
  return blocked.check(ip, "ipv6");
}

export class BlockedAddressError extends Error {
  readonly code = "ERR_BLOCKED_ADDRESS";
  constructor(readonly host: string, readonly address: string) {
    super(`${host} resolves to ${address}, a private or reserved address`);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `dns.lookup` replacement for `http.request` that refuses private
 * addresses. Because the check runs on the addresses the socket is about to
 * use, a DNS answer that changes between a check and the connection (DNS
 * rebinding) cannot get around it.
 */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(new BlockedAddressError(hostname, bad.address) as unknown as NodeJS.ErrnoException, "");
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}
