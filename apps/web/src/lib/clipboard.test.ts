import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

interface FakeTextarea {
  value: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  selectionRange?: [number, number];
  selected: boolean;
  attached: boolean;
  setAttribute: (name: string, value: string) => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
  remove: () => void;
}

interface FakeDom {
  textareas: FakeTextarea[];
  copiedFrom: FakeTextarea[];
  focused: string[];
}

function stubDom(options: {
  execCommand?: (command: string) => boolean;
  selectThrows?: boolean;
  activeElement?: { focus: () => void } | null;
}): FakeDom {
  const dom: FakeDom = { textareas: [], copiedFrom: [], focused: [] };
  const createTextarea = (): FakeTextarea => {
    const textarea: FakeTextarea = {
      value: "",
      style: {},
      attributes: {},
      selected: false,
      attached: false,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      select() {
        if (options.selectThrows) throw new Error("select is not supported");
        this.selected = true;
      },
      setSelectionRange(start, end) {
        this.selectionRange = [start, end];
      },
      remove() {
        this.attached = false;
      },
    };
    dom.textareas.push(textarea);
    return textarea;
  };

  vi.stubGlobal("document", {
    activeElement: options.activeElement ?? null,
    createElement: () => createTextarea(),
    body: {
      append: (textarea: FakeTextarea) => {
        textarea.attached = true;
      },
    },
    execCommand: (command: string) => {
      const attached = dom.textareas.find((textarea) => textarea.attached);
      if (attached) dom.copiedFrom.push(attached);
      return options.execCommand
        ? options.execCommand(command)
        : true;
    },
  });
  return dom;
}

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the async clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const dom = stubDom({});

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(dom.textareas).toHaveLength(0);
  });

  it("falls back to the copy command in insecure contexts", async () => {
    vi.stubGlobal("navigator", {});
    const dom = stubDom({});

    await expect(copyText("hello")).resolves.toBe(true);
    expect(dom.copiedFrom).toHaveLength(1);
    expect(dom.textareas[0]?.value).toBe("hello");
  });

  it("selects an explicit range, which WebKit requires on a readonly textarea", async () => {
    vi.stubGlobal("navigator", {});
    const dom = stubDom({});

    await copyText("hello");

    const textarea = dom.textareas[0];
    expect(textarea?.attributes["readonly"]).toBe("");
    expect(textarea?.selected).toBe(true);
    expect(textarea?.selectionRange).toEqual([0, 5]);
  });

  it("keeps the textarea inside the viewport while hiding it", async () => {
    vi.stubGlobal("navigator", {});
    const dom = stubDom({});

    await copyText("hello");

    expect(dom.textareas[0]?.style).toMatchObject({
      position: "fixed",
      top: "0",
      left: "0",
      opacity: "0",
    });
  });

  it("removes the textarea even when selection throws", async () => {
    vi.stubGlobal("navigator", {});
    const dom = stubDom({ selectThrows: true });

    await expect(copyText("hello")).resolves.toBe(false);
    expect(dom.textareas).toHaveLength(1);
    expect(dom.textareas[0]?.attached).toBe(false);
  });

  it("reports failure when the copy command reports failure", async () => {
    vi.stubGlobal("navigator", {});
    const dom = stubDom({ execCommand: () => false });

    await expect(copyText("hello")).resolves.toBe(false);
    expect(dom.textareas[0]?.attached).toBe(false);
  });

  it("retries with the copy command when the clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const dom = stubDom({});

    await expect(copyText("hello")).resolves.toBe(true);
    expect(dom.copiedFrom).toHaveLength(1);
  });

  it("restores focus to the previously focused element", async () => {
    vi.stubGlobal("navigator", {});
    const focus = vi.fn();
    stubDom({ activeElement: { focus } });

    await copyText("hello");

    expect(focus).toHaveBeenCalledOnce();
  });
});
