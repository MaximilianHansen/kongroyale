#!/usr/bin/env python3
# NETPATH: an emulated WAN path between two Linux network namespaces, for running the real server and real clients
# over real kernel TCP with added latency, jitter and packet loss. It does what `tc qdisc ... netem` does, for kernels
# built without netem (CONFIG_NET_SCH_NETEM unset, as on the cloud runners this was written on): a userspace relay
# reads every IP packet from a TUN device in one namespace and writes it into a TUN device in the other after the
# one-way delay, or drops it.
#
#   sudo python3 tools/performance/netpath.py --rtt 150 --jitter 20 --loss 1 [--seed 1] [--secs 0]
#
#   namespaces:  kr-srv (10.77.0.1) <-> kr-cli (10.77.0.2); created if missing, left in place for the next run
#   --rtt        round-trip time added, ms; each direction gets half
#   --jitter     each packet's one-way delay moves by a uniform amount in +-jitter/2 ms (netlab's convention, so
#                "--jitter 20" means the same thing in both tools). Packets never overtake each other: like a real
#                path (and like netlab's pipes), a packet that drew a short delay waits behind the one before it.
#   --loss       percent of IP packets dropped, each direction independently, ACKs included; TCP retransmits them
#   --secs       stop after this many seconds (0: run until killed)
#   --down       delete the namespaces and exit
#
# Run a process inside a namespace as your own user:
#   sudo ip netns exec kr-srv sudo -u "$USER" env "PATH=$PATH" KR_EVENT_MODE=0 KR_WARMUP_S=5 KR_HOST=10.77.0.1 npm start
#   sudo ip netns exec kr-cli sudo -u "$USER" env "PATH=$PATH" npx tsx tools/performance/sockets.mts --url http://10.77.0.1:3020 --players 2 --aux
#
# What it is not: a bandwidth limiter, a reordering or burst-loss model, or a real WAN. Results from it are
# "emulated path" results and are labelled that way. Linux only; needs root (TUN devices and namespaces).
import argparse, ctypes, fcntl, heapq, os, random, select, signal, struct, subprocess, sys, time

TUNSETIFF, IFF_TUN, IFF_NO_PI, CLONE_NEWNET = 0x400454CA, 0x0001, 0x1000, 0x40000000
LIBC = ctypes.CDLL(None, use_errno=True)
NS = (("kr-srv", "10.77.0.1", "10.77.0.2"), ("kr-cli", "10.77.0.2", "10.77.0.1"))


def sh(*a):
    subprocess.run(a, check=True)


def open_tun(ns, me, peer):
    if not os.path.exists(f"/var/run/netns/{ns}"):
        sh("ip", "netns", "add", ns)
    fd_ns = os.open(f"/var/run/netns/{ns}", os.O_RDONLY)
    # libc setns rather than os.setns, which only exists from Python 3.12
    if LIBC.setns(fd_ns, CLONE_NEWNET) != 0:
        sys.exit(f"netpath: setns({ns}) failed: {os.strerror(ctypes.get_errno())}")
    os.close(fd_ns)
    fd = os.open("/dev/net/tun", os.O_RDWR | os.O_NONBLOCK)
    fcntl.ioctl(fd, TUNSETIFF, struct.pack("16sH", b"krt", IFF_TUN | IFF_NO_PI))
    sh("ip", "netns", "exec", ns, "ip", "link", "set", "lo", "up")
    sh("ip", "netns", "exec", ns, "ip", "addr", "flush", "dev", "krt")
    sh("ip", "netns", "exec", ns, "ip", "addr", "add", me, "peer", peer, "dev", "krt")
    sh("ip", "netns", "exec", ns, "ip", "link", "set", "krt", "up")
    return fd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rtt", type=float, default=0)
    ap.add_argument("--jitter", type=float, default=0)
    ap.add_argument("--loss", type=float, default=0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--secs", type=float, default=0)
    ap.add_argument("--down", action="store_true")
    a = ap.parse_args()
    if os.geteuid() != 0:
        sys.exit("netpath: run as root (sudo)")
    if a.down:
        for ns, _, _ in NS:
            subprocess.run(["ip", "netns", "del", ns], stderr=subprocess.DEVNULL)
        return
    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    rnd = random.Random(a.seed)
    fds = [open_tun(*NS[0]), open_tun(*NS[1])]
    ow, loss = a.rtt / 2000.0, a.loss / 100.0
    last = [0.0, 0.0]
    seen, dropped = [0, 0], [0, 0]
    q, n = [], 0
    end = time.monotonic() + a.secs if a.secs > 0 else float("inf")
    print(f"netpath: kr-srv 10.77.0.1 <-> kr-cli 10.77.0.2, rtt {a.rtt} ms, jitter +-{a.jitter / 2} ms per way, loss {a.loss}%", flush=True)
    try:
        while time.monotonic() < end:
            now = time.monotonic()
            while q and q[0][0] <= now:
                _, _, to, pkt = heapq.heappop(q)
                try:
                    os.write(fds[to], pkt)
                except BlockingIOError:
                    pass
            ready, _, _ = select.select(fds, [], [], max(0.0, min(q[0][0] - now if q else 0.05, 0.05)))
            now = time.monotonic()
            for fd in ready:
                src = fds.index(fd)
                while True:
                    try:
                        pkt = os.read(fd, 65535)
                    except BlockingIOError:
                        break
                    seen[src] += 1
                    if loss and rnd.random() < loss:
                        dropped[src] += 1
                        continue
                    at = max(last[src], now + ow + (rnd.random() - 0.5) * a.jitter / 1000.0)
                    last[src] = at
                    n += 1
                    heapq.heappush(q, (at, n, 1 - src, pkt))
    except KeyboardInterrupt:
        pass
    print(f"netpath: packets srv->cli {seen[0]} (dropped {dropped[0]}), cli->srv {seen[1]} (dropped {dropped[1]})", flush=True)


main()
