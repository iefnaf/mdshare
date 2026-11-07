// Builds the share links. Pure, so it is unit-tested without Electron.
// primary: <LocalHostName>.local (stable across DHCP changes, PLAN G4)
// ip:      a private LAN IPv4, used for the QR because Android's .local support is patchy.

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

/**
 * @param {{port:number, token:string, localHostName:string, hosts:string[]}} p
 *   hosts: "host:port" values from lanHosts()
 */
export function shareUrls ({ port, token, localHostName, hosts }) {
  const frag = `#t=${encodeURIComponent(token)}`
  const ips = hosts.map(h => h.slice(0, h.lastIndexOf(':'))).filter(h => /^\d+\.\d+\.\d+\.\d+$/.test(h))
  const ip = ips.find(a => PRIVATE.some(r => r.test(a))) ?? ips[0] ?? null
  const name = (localHostName ?? '').toLowerCase().replace(/\.local$/, '')
  const ipUrl = ip ? `http://${ip}:${port}/${frag}` : null
  const nameUrl = name ? `http://${name}.local:${port}/${frag}` : null
  // Without any LAN IPv4 we are not on a network; a .local link alone would not work for guests.
  return { primary: ip ? (nameUrl ?? ipUrl) : null, ip: ipUrl }
}
