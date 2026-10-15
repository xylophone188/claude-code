#!/usr/bin/env python3
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).parent))

from nacos_topology_adapter import (
    Node,
    load_nodes,
    parse_node,
    write_routes,
    default_desktop_node,
)


class TestNacosTopologyAdapter(unittest.TestCase):
    def test_default_desktop_node(self):
        node = default_desktop_node()
        self.assertEqual(node.role, "desktop")
        self.assertEqual(node.port, 20148)
        self.assertEqual(node.weight, 100)
        self.assertIn("llm-inference", node.capabilities)
        meta = node.nacos_metadata()
        self.assertEqual(meta["role"], "desktop")
        self.assertEqual(meta["endpoint"], "127.0.0.1:20148")

    def test_parse_node_valid(self):
        raw = {
            "id": "test-vps",
            "role": "vps",
            "host": "1.2.3.4",
            "port": 443,
            "capabilities": ["relay"],
            "metadata": {"region": "us-west"},
        }
        node = parse_node(raw)
        self.assertEqual(node.node_id, "test-vps")
        self.assertEqual(node.role, "vps")
        self.assertEqual(node.weight, 30.0)
        self.assertEqual(node.latency_type, "medium")
        self.assertEqual(node.metadata["region"], "us-west")

    def test_parse_node_invalid_role(self):
        raw = {
            "id": "bad-node",
            "role": "unknown-role",
            "host": "1.2.3.4",
            "port": 80,
        }
        with self.assertRaises(ValueError):
            parse_node(raw)

    def test_write_routes(self):
        with TemporaryDirectory() as tmp_dir:
            json_path = Path(tmp_dir) / "routes.json"
            nginx_path = Path(tmp_dir) / "upstreams.conf"
            instances = [
                {
                    "ip": "127.0.0.1",
                    "port": 20148,
                    "weight": 100.0,
                    "healthy": True,
                    "enabled": True,
                    "metadata": {
                        "node_id": "pc-source-b",
                        "role": "desktop",
                        "latency_type": "low",
                        "capabilities": "gateway,inference",
                    },
                },
                {
                    "ip": "49.51.228.166",
                    "port": 12028,
                    "weight": 30.0,
                    "healthy": True,
                    "enabled": True,
                    "metadata": {
                        "node_id": "vps-edge",
                        "role": "vps",
                        "latency_type": "medium",
                        "capabilities": "ingress-relay",
                    },
                },
            ]
            write_routes(instances, json_path, nginx_path)
            self.assertTrue(json_path.exists())
            self.assertTrue(nginx_path.exists())

            routes_data = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(len(routes_data["upstreams"]), 2)
            self.assertEqual(routes_data["upstreams"][0]["id"], "pc-source-b")
            self.assertEqual(routes_data["upstreams"][0]["weight"], 100.0)

            nginx_content = nginx_path.read_text(encoding="utf-8")
            self.assertIn("upstream nacos_agent_ecosystem_nodes {", nginx_content)
            self.assertIn("server 127.0.0.1:20148 weight=100.0 max_fails=3 fail_timeout=15s;", nginx_content)
            self.assertIn("server 49.51.228.166:12028 weight=30.0 max_fails=3 fail_timeout=15s;", nginx_content)


if __name__ == "__main__":
    unittest.main()
