#!/bin/sh
#
# Bring the container onto the tailnet, if it has been given a key, then exec
# the backend.
#
# The gate is TS_AUTHKEY, and its absence is the normal case: with no key
# nothing starts, nothing is configured, and the image behaves exactly as it did
# before Tailscale was added to it. A deployment that does not use a self-hosted
# fleet should not be running a networking daemon it has no use for.
#
# Userspace networking, because a PaaS container has no NET_ADMIN and cannot
# create a TUN device. tailscaled exposes a local HTTP proxy instead; the fleet
# client dials through it and nothing else in the backend's networking changes.
set -e

if [ -n "${TS_AUTHKEY:-}" ]; then
  echo "[entrypoint] starting tailscaled (userspace) for fleet connectivity"
  mkdir -p /var/lib/tailscale /var/run/tailscale

  # Tunnel MTU. Tailscale's default is 1280 and on this path it BLACK-HOLES:
  # anything that fits in one segment arrives, anything larger never does, in
  # either direction. Small responses (/healthz, /v1/capacity) worked
  # throughout, which is exactly why it went unnoticed until a response with a
  # real payload in it was tried — dispatch timed out at 20s, transcripts could
  # not be read at all, and the failure read as "the fleet is unreachable".
  #
  # Measured, not guessed. At the default: /v1/runs returned 0 bytes and timed
  # out, a 60KB upload took 3.4s (~17KB/s, retransmit-shaped). At 1000: 10,675
  # bytes in 20ms, 8 times out of 8, and the same upload in 0.04s.
  #
  # 1000 rather than something nearer the default because the headroom is worth
  # more than the throughput: the cost is a few percent of per-packet overhead
  # on a link carrying transcripts, and the failure mode it avoids is silent and
  # looks like a network outage. Override with TS_DEBUG_MTU if a deployment's
  # path is known to carry more.
  export TS_DEBUG_MTU="${TS_DEBUG_MTU:-1000}"
  echo "[entrypoint] tailscale tunnel MTU: ${TS_DEBUG_MTU}"

  # --tun=userspace-networking: no interface, no netfilter, no capabilities.
  # --outbound-http-proxy-listen is what the fleet client dials through; undici
  # speaks to an HTTP proxy natively, which SOCKS would have needed a shim for.
  /usr/local/sbin/tailscaled \
    --tun=userspace-networking \
    --state=/var/lib/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    --outbound-http-proxy-listen="${FLEET_TS_PROXY_LISTEN:-localhost:1055}" \
    --port=0 &

  # Wait for the socket rather than sleeping a guess: `tailscale up` against a
  # daemon that has not finished starting fails, and a container that dies on a
  # race is one that half the time comes up without fleet connectivity and
  # gives no clue why.
  i=0
  while [ ! -S /var/run/tailscale/tailscaled.sock ] && [ "$i" -lt 30 ]; do
    i=$((i + 1)); sleep 1
  done

  # --hostname so the machine is identifiable in the admin console.
  #
  # THE KEY MUST BE EPHEMERAL. This container has no persistent volume, so every
  # deploy starts with empty tailscaled state and registers as a NEW node.
  # With a normal key the old node lingers, Tailscale disambiguates the taken
  # hostname, and you accumulate talyn-backend-1, -2, -3... one per deploy, all
  # tagged and all apparently valid ACL sources. An ephemeral key makes the node
  # remove itself shortly after it goes offline, which is exactly the container
  # lifecycle. See docs/SETUP.md.
  #
  # --accept-routes=false: we want to reach fleet hosts, not inherit anybody's
  # subnet routes.
  if /usr/local/bin/tailscale --socket=/var/run/tailscale/tailscaled.sock up \
       --authkey="${TS_AUTHKEY}" \
       --hostname="${TS_HOSTNAME:-talyn-backend}" \
       --accept-routes=false \
       --accept-dns=false; then
    echo "[entrypoint] tailnet up as ${TS_HOSTNAME:-talyn-backend}"
  else
    # NOT fatal. The fleet is one provider among several; a backend that
    # refuses to boot because a tailnet is unreachable takes down PostHog Code
    # and Claude Code tasks too, which is a far worse outage than "self-hosted
    # dispatch is unavailable".
    echo "[entrypoint] WARNING: tailscale up failed — the self-hosted fleet will be unreachable" >&2
  fi
fi

exec "$@"
