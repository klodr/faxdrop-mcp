import { errorResult, textResult } from "../src/tools/_shared.js";

describe("_shared helpers", () => {
  describe("textResult / errorResult — structuredContent wrapping", () => {
    it("passes a JSON object through to structuredContent unchanged", () => {
      const r = textResult({ id: "fax_1", status: "delivered" });
      expect(r.structuredContent).toEqual({ id: "fax_1", status: "delivered" });
      expect(r.isError).toBeUndefined();
    });

    it("wraps a primitive in { value }", () => {
      const r = textResult(42);
      expect(r.structuredContent).toEqual({ value: 42 });
    });

    it("wraps a string in { value }", () => {
      const r = textResult("hello");
      expect(r.structuredContent).toEqual({ value: "hello" });
    });

    it("wraps an array in { value } (structuredContent must be a JSON object per MCP spec)", () => {
      const r = textResult([1, 2, 3]);
      expect(r.structuredContent).toEqual({ value: [1, 2, 3] });
    });

    it("wraps null in { value }", () => {
      const r = textResult(null);
      expect(r.structuredContent).toEqual({ value: null });
    });

    it("wraps undefined in { value } (parallel to the null case)", () => {
      const r = textResult(undefined);
      expect(r.structuredContent).toEqual({ value: undefined });
    });

    it("errorResult sets isError + same structuredContent shape", () => {
      const r = errorResult({ error_type: "bad_request", message: "boom" });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toEqual({ error_type: "bad_request", message: "boom" });
    });

    it("both helpers fence-wrap the text content", () => {
      const ok = textResult({ x: 1 });
      const err = errorResult({ x: 1 });
      expect(ok.content[0].text).toContain("<untrusted-tool-output>");
      expect(err.content[0].text).toContain("<untrusted-tool-output>");
    });
  });
});
