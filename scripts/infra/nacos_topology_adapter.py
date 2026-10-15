#!/usr/bin/env python3
"""Maintain Nacos membership and materialize safe OmniRoute routing snapshots.

The adapter is intentionally a controller-side process: it probes every declared
endpoint, registers only healthy nodes as ephemeral Nacos instances, renews their
heartbeats, and immediately deregisters a node when its health endpoint fails.
It never reloads OpenResty/APISIX itself; operators may validate and include the
rendered upstream fragment through their existing deployment process.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_NACOS_URL = "http://127.0.0.1:8848"
DEFAULT_SERVICE = "agent-ecosystem-nodes"
DEFAULT_GROUP = "DEFAULT_GROUP"
DEFAULT_STATE_DIR = Path.home() / ".local" / "state" / "ccb-nacos"
VALID_ROLES = {"mobile", "desktop", "vps"}


@dataclass(frozen=True)
class Node:
    node_id: str
    role: str
    host: str
    port: int
    weight: float
    latency_type: str
    health_url: str
    capabilities: tuple[str, ...]
    metadata: dict[str, str]

    @property
    def endpoint(self) -> str:
        return f"{self.host}:{self.port}"

    def nacos_metadata(self) -> dict[str, str]:
        return {
            "node_id": self.node_id,
            "role": self.role,
            "weight": str(self.weight),
            "latency_type": self.latency_type,
            "endpoint": self.endpoint,
            "capabilities": ",".join(self.capabilities),
            **self.metadata,
        }


def request_json(url: str, method: str = "GET", form: dict[str, str] | None = None, timeout: float = 5) -> Any:
    data = urlencode(form).encode() if form is not None else None
    request = Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else None


def request_text(url: str, method: str = "GET", form: dict[str, str] | None = None, timeout: float = 5) -> str:
    data = urlencode(form).encode() if form is not None else None
    request = Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def tcp_reachable(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def node_is_healthy(node: Node, timeout: float) -> bool:
    if node.health_url:
        try:
            request_text(node.health_url, timeout=timeout)
            return True
        except HTTPError as error:
            # A protected endpoint still proves the node's TCP and HTTP stack are alive.
            return 400 <= error.code < 500
        except (URLError, TimeoutError, OSError):
            return False
    return tcp_reachable(node.host, node.port, timeout)


class NacosClient:
    def __init__(self, base_url: str, service: str, group: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.service = service
        self.group = group
        self.timeout = timeout

    def readiness(self) -> bool:
        try:
            return request_text(
                f"{self.base_url}/nacos/v1/console/health/readiness", timeout=self.timeout
            ).strip() == "OK"
        except (HTTPError, URLError, TimeoutError, OSError):
            return False

    def register(self, node: Node) -> None:
        response = request_text(
            f"{self.base_url}/nacos/v1/ns/instance",
            method="POST",
            form={
                "serviceName": self.service,
                "groupName": self.group,
                "ip": node.host,
                "port": str(node.port),
                "weight": str(node.weight),
                "ephemeral": "true",
                "enabled": "true",
                "healthy": "true",
                "metadata": json.dumps(node.nacos_metadata(), separators=(",", ":")),
            },
            timeout=self.timeout,
        )
        if response.strip().lower() != "ok":
            raise RuntimeError(f"Nacos rejected registration for {node.node_id}: {response}")

    def beat(self, node: Node) -> None:
        beat = {
            "ip": node.host,
            "port": node.port,
            "serviceName": self.service,
            "groupName": self.group,
            "weight": node.weight,
            "metadata": node.nacos_metadata(),
            "scheduled": False,
        }
        response = request_json(
            f"{self.base_url}/nacos/v1/ns/instance/beat?{urlencode({'serviceName': self.service, 'groupName': self.group, 'beat': json.dumps(beat, separators=(',', ':'))})}",
            method="PUT",
            timeout=self.timeout,
        )
        if not isinstance(response, dict) or not response.get("clientBeatInterval"):
            raise RuntimeError(f"Nacos heartbeat failed for {node.node_id}: {response!r}")

    def deregister(self, node: Node) -> None:
        response = request_text(
            f"{self.base_url}/nacos/v1/ns/instance?{urlencode({'serviceName': self.service, 'groupName': self.group, 'ip': node.host, 'port': str(node.port), 'ephemeral': 'true'})}",
            method="DELETE",
            timeout=self.timeout,
        )
        if response.strip().lower() != "ok":
            raise RuntimeError(f"Nacos rejected deregistration for {node.node_id}: {response}")

    def instances(self) -> list[dict[str, Any]]:
        payload = request_json(
            f"{self.base_url}/nacos/v1/ns/instance/list?{urlencode({'serviceName': self.service, 'groupName': self.group, 'healthyOnly': 'true'})}",
            timeout=self.timeout,
        )
        return [host for host in payload.get("hosts", []) if host.get("healthy") and host.get("enabled")]

    def get_config(self, data_id: str) -> str | None:
        try:
            return request_text(
                f"{self.base_url}/nacos/v1/cs/configs?{urlencode({'dataId': data_id, 'group': self.group})}",
                timeout=self.timeout,
            )
        except HTTPError as error:
            if error.code == 404:
                return None
            raise

    def publish_config(self, data_id: str, content: str) -> None:
        response = request_text(
            f"{self.base_url}/nacos/v1/cs/configs",
            method="POST",
            form={
                "dataId": data_id,
                "group": self.group,
                "content": content,
                "type": "json",
            },
            timeout=self.timeout,
        )
        if response.strip().lower() != "true":
            raise RuntimeError(f"Nacos rejected config publish for {data_id}: {response}")


def parse_node(raw: dict[str, Any]) -> Node:
    required = ("id", "role", "host", "port")
    missing = [name for name in required if name not in raw]
    if missing:
        raise ValueError(f"node is missing required fields: {', '.join(missing)}")
    role = str(raw["role"])
    if role not in VALID_ROLES:
        raise ValueError(f"node {raw['id']} has invalid role {role!r}; expected one of {sorted(VALID_ROLES)}")
    capabilities = raw.get("capabilities", [])
    if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
        raise ValueError(f"node {raw['id']} capabilities must be a string list")
    metadata = raw.get("metadata", {})
    if not isinstance(metadata, dict) or not all(isinstance(key, str) and isinstance(value, (str, int, float, bool)) for key, value in metadata.items()):
        raise ValueError(f"node {raw['id']} metadata must map strings to scalar values")
    host = str(raw["host"])
    port = int(raw["port"])
    if not 1 <= port <= 65535:
        raise ValueError(f"node {raw['id']} port must be between 1 and 65535")
    return Node(
        node_id=str(raw["id"]),
        role=role,
        host=host,
        port=port,
        weight=float(raw.get("weight", {"desktop": 100, "vps": 30, "mobile": 10}[role])),
        latency_type=str(raw.get("latency_type", {"desktop": "low", "vps": "medium", "mobile": "variable"}[role])),
        health_url=str(raw.get("health_url", "")),
        capabilities=tuple(capabilities),
        metadata={key: str(value).lower() if isinstance(value, bool) else str(value) for key, value in metadata.items()},
    )


def load_nodes(path: Path) -> list[Node]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_nodes = payload.get("nodes") if isinstance(payload, dict) else payload
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise ValueError("nodes file must be a non-empty JSON array or an object with a non-empty 'nodes' array")
    nodes = [parse_node(raw) for raw in raw_nodes]
    identities = {(node.host, node.port) for node in nodes}
    if len(identities) != len(nodes):
        raise ValueError("nodes must have distinct host and port combinations")
    return nodes


def default_desktop_node() -> Node:
    return Node(
        node_id="pc-omniroute-source-b",
        role="desktop",
        host="127.0.0.1",
        port=20148,
        weight=100,
        latency_type="low",
        health_url="http://127.0.0.1:20148/health",
        capabilities=("gateway", "llm-inference", "control-plane"),
        metadata={"source": "nacos-topology-adapter"},
    )


def write_routes(instances: list[dict[str, Any]], json_path: Path, nginx_path: Path) -> None:
    routes = []
    for instance in instances:
        metadata = instance.get("metadata") or {}
        routes.append({
            "id": metadata.get("node_id", instance.get("instanceId")),
            "role": metadata.get("role", "unknown"),
            "endpoint": f"{instance['ip']}:{instance['port']}",
            "weight": instance.get("weight", 1),
            "latency_type": metadata.get("latency_type", "unknown"),
            "capabilities": [item for item in metadata.get("capabilities", "").split(",") if item],
        })
    routes.sort(key=lambda route: (-float(route["weight"]), route["endpoint"]))
    json_path.parent.mkdir(parents=True, exist_ok=True)
    nginx_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps({"generated_at": int(time.time()), "upstreams": routes}, indent=2) + "\n", encoding="utf-8")
    upstream_lines = ["# Generated by nacos_topology_adapter.py. Validate before gateway reload.", "upstream nacos_agent_ecosystem_nodes {"]
    for route in routes:
        upstream_lines.append(f"    server {route['endpoint']} weight={route['weight']} max_fails=3 fail_timeout=15s;")
    upstream_lines.append("    keepalive 32;")
    upstream_lines.append("}")
    nginx_path.write_text("\n".join(upstream_lines) + "\n", encoding="utf-8")


def print_status(nodes: list[Node], timeout: float) -> int:
    statuses = [{"id": node.node_id, "role": node.role, "endpoint": node.endpoint, "healthy": node_is_healthy(node, timeout)} for node in nodes]
    print(json.dumps({"nodes": statuses}, indent=2))
    return 0 if all(status["healthy"] for status in statuses) else 2


def run_once(client: NacosClient, nodes: list[Node], timeout: float, sync_paths: tuple[Path, Path]) -> int:
    failures = []
    for node in nodes:
        try:
            if node_is_healthy(node, timeout):
                client.register(node)
            else:
                client.deregister(node)
                failures.append(node.node_id)
        except (HTTPError, URLError, TimeoutError, OSError, RuntimeError) as error:
            failures.append(f"{node.node_id}: {error}")
    write_routes(client.instances(), *sync_paths)
    print(json.dumps({"service": client.service, "registered": [node.node_id for node in nodes if node.node_id not in failures], "unhealthy_or_failed": failures}, indent=2))
    return 0 if not failures else 2


def run_daemon(client: NacosClient, nodes: list[Node], timeout: float, interval: float, sync_paths: tuple[Path, Path], failure_threshold: int = 3) -> int:
    active: dict[str, Node] = {}
    failures: dict[str, int] = {}
    stopping = False

    def stop(_: int, __: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while not stopping:
        for node in nodes:
            healthy = node_is_healthy(node, timeout)
            if healthy:
                failures.pop(node.node_id, None)
            else:
                failures[node.node_id] = failures.get(node.node_id, 0) + 1
            try:
                if healthy:
                    if node.node_id in active:
                        client.beat(node)
                    else:
                        client.register(node)
                        active[node.node_id] = node
                elif node.node_id in active and failures[node.node_id] >= failure_threshold:
                    client.deregister(node)
                    del active[node.node_id]
                    failures.pop(node.node_id, None)
                elif node.node_id in active:
                    client.beat(node)
                    print(f"{node.node_id}: health probe failed ({failures[node.node_id]}/{failure_threshold}); retaining registration", file=sys.stderr)
                else:
                    print(f"{node.node_id}: health probe failed ({failures[node.node_id]}/{failure_threshold}); not registering", file=sys.stderr)

            except (HTTPError, URLError, TimeoutError, OSError, RuntimeError) as error:
                print(f"{node.node_id}: {error}", file=sys.stderr)
                active.pop(node.node_id, None)
        try:
            write_routes(client.instances(), *sync_paths)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            print(f"route sync: {error}", file=sys.stderr)
        deadline = time.monotonic() + interval
        while not stopping and time.monotonic() < deadline:
            time.sleep(min(0.2, deadline - time.monotonic()))
    for node in list(active.values()):
        try:
            client.deregister(node)
        except (HTTPError, URLError, TimeoutError, OSError, RuntimeError) as error:
            print(f"cleanup {node.node_id}: {error}", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nacos-url", default=os.environ.get("NACOS_URL", DEFAULT_NACOS_URL))
    parser.add_argument("--service", default=os.environ.get("NACOS_SERVICE", DEFAULT_SERVICE))
    parser.add_argument("--group", default=os.environ.get("NACOS_GROUP", DEFAULT_GROUP))
    parser.add_argument("--nodes-file", type=Path, help="JSON descriptor for desktop/mobile/VPS nodes; defaults to the local OmniRoute Source B node")
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between daemon heartbeats; Nacos default is 5 seconds")
    parser.add_argument("--routes-output", type=Path, default=DEFAULT_STATE_DIR / "dynamic-routes.json")
    parser.add_argument("--nginx-output", type=Path, default=DEFAULT_STATE_DIR / "nacos-upstreams.conf")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="probe declared endpoints without changing Nacos")
    mode.add_argument("--register-once", action="store_true", help="probe, register healthy nodes, deregister failed nodes, and write routing snapshots")
    mode.add_argument("--daemon", action="store_true", help="maintain heartbeats and routing snapshots until interrupted")
    mode.add_argument("--sync-routes", action="store_true", help="read healthy Nacos instances and write routing snapshots")
    mode.add_argument("--publish-config", metavar="DATA_ID", help="publish the generated routing snapshot to Nacos config center")
    mode.add_argument("--read-config", metavar="DATA_ID", help="print a Nacos configuration document")
    args = parser.parse_args()

    if args.timeout <= 0 or args.interval <= 0:
        parser.error("--timeout and --interval must be greater than zero")
    nodes = load_nodes(args.nodes_file) if args.nodes_file else [default_desktop_node()]
    client = NacosClient(args.nacos_url, args.service, args.group, args.timeout)
    if not client.readiness():
        print(f"Nacos is not ready at {args.nacos_url}", file=sys.stderr)
        return 1
    if args.probe:
        return print_status(nodes, args.timeout)
    if args.read_config:
        config = client.get_config(args.read_config)
        if config is None:
            print(f"Nacos config not found: {args.read_config}", file=sys.stderr)
            return 2
        print(config)
        return 0
    sync_paths = (args.routes_output, args.nginx_output)
    if args.publish_config:
        instances = client.instances()
        write_routes(instances, *sync_paths)
        content = args.routes_output.read_text(encoding="utf-8")
        client.publish_config(args.publish_config, content)
        print(json.dumps({"published_config": args.publish_config, "instances_count": len(instances), "routes_file": str(args.routes_output)}, indent=2))
        return 0
    sync_paths = (args.routes_output, args.nginx_output)
    if args.sync_routes:
        write_routes(client.instances(), *sync_paths)
        print(json.dumps({"instances": len(client.instances()), "routes_output": str(args.routes_output), "nginx_output": str(args.nginx_output)}, indent=2))
        return 0
    if args.register_once:
        return run_once(client, nodes, args.timeout, sync_paths)
    return run_daemon(client, nodes, args.timeout, args.interval, sync_paths)


if __name__ == "__main__":
    raise SystemExit(main())
