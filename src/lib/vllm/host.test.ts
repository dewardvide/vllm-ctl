import { describe, expect, it } from "vitest";

import { baseUrl, connectHost, isLoopback } from "./host";

describe("connectHost", () => {
  it("collapses a wildcard bind to loopback", () => {
    // 0.0.0.0 is a bind address, not a destination: connecting to it is what
    // made health probes and benchmark targets wrong.
    expect(connectHost("0.0.0.0")).toBe("127.0.0.1");
    expect(connectHost("")).toBe("127.0.0.1");
    expect(connectHost("::")).toBe("[::1]");
    expect(connectHost("[::]")).toBe("[::1]");
  });

  it("dials a specific address as given", () => {
    expect(connectHost("192.168.1.23")).toBe("192.168.1.23");
    expect(connectHost("127.0.0.1")).toBe("127.0.0.1");
    expect(connectHost("localhost")).toBe("localhost");
  });

  it("brackets a bare IPv6 literal for use in a URL", () => {
    expect(connectHost("fd00::1")).toBe("[fd00::1]");
    expect(connectHost("[fd00::1]")).toBe("[fd00::1]");
  });

  it("ignores surrounding whitespace from the settings field", () => {
    expect(connectHost("  0.0.0.0  ")).toBe("127.0.0.1");
  });
});

describe("baseUrl", () => {
  it("builds a connectable URL from a bind address", () => {
    expect(baseUrl("0.0.0.0", 8000)).toBe("http://127.0.0.1:8000");
    expect(baseUrl("192.168.1.23", 8001)).toBe("http://192.168.1.23:8001");
    expect(baseUrl("::", 8000)).toBe("http://[::1]:8000");
  });
});

describe("isLoopback", () => {
  it("recognises every spelling of loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
  });

  it("treats wildcards and routable addresses as exposed", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("::")).toBe(false);
    expect(isLoopback("192.168.1.23")).toBe(false);
  });
});
