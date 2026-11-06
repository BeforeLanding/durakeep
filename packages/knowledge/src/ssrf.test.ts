import { expect, test } from "vitest";
import { expandIPv6, isBlockedHostname, isPublicIp } from "./ssrf.ts";

test("S6：loopback、私网、链路本地、云元数据、CGNAT、保留段都被拒绝", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "192.0.0.1", "198.18.0.1",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.0.2.1", "203.0.113.9",
  ]) expect(isPublicIp(ip), ip).toBe(false);
});

test("公网 IPv4 放行，包括私网段的边界外侧", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "11.0.0.1", "223.255.255.255"]) {
    expect(isPublicIp(ip), ip).toBe(true);
  }
});

test("IPv6：::1、::、唯一本地、链路本地、组播、文档段被拒绝；公网放行", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "[::1]", "0:0:0:0:0:0:0:1", "fe80::1%eth0"]) {
    expect(isPublicIp(ip), ip).toBe(false);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4009::1"]) expect(isPublicIp(ip), ip).toBe(true);
});

test("IPv4-mapped / 兼容 / NAT64 / 6to4：按内嵌的 IPv4 判断（绕过尝试）", () => {
  for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:a00:1::1", "0:0:0:0:0:ffff:192.168.0.1"]) {
    expect(isPublicIp(ip), ip).toBe(false);
  }
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) expect(isPublicIp(ip), ip).toBe(true);
});

test("无法解析的字符串一律不放行；展开函数正确", () => {
  for (const s of ["", "abc", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::g", "1:2:3:4:5:6:7:8:9"]) expect(isPublicIp(s), s).toBe(false);
  expect(expandIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  expect(expandIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  expect(expandIPv6("2001:db8::8a2e:370:7334")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
});

test("主机名黑名单：localhost、*.localhost、元数据主机、*.internal / *.local", () => {
  for (const h of ["localhost", "LOCALHOST", "foo.localhost", "metadata.google.internal", "metadata.google.internal.", "x.internal", "printer.local", "instance-data"]) {
    expect(isBlockedHostname(h), h).toBe(true);
  }
  for (const h of ["example.com", "localhost.example.com", "notlocal.com"]) expect(isBlockedHostname(h), h).toBe(false);
});
