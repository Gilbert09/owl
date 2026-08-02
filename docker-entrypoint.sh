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

  # --hostname so the machine is identifiable in the admin console; Railway
  # replaces containers, and a tailnet full of anonymous ephemeral nodes is
  # impossible to reason about. --accept-routes=false: we want to reach fleet
  # hosts, not inherit anybody's subnet routes.
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
