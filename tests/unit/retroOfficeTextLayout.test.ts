import { describe, expect, it } from "vitest";

import {
  buildSpeechBubbleTextLayout,
  formatAgentNameplateText,
  formatAgentSubtitleText,
  measureDisplayUnits,
  wrapTextByDisplayUnits,
} from "@/features/retro-office/objects/textLayout";

describe("retro office text layout", () => {
  it("truncates CJK nameplates by visual width instead of code unit count", () => {
    const text = formatAgentNameplateText("高级中文产品经理负责人");

    expect(measureDisplayUnits(text)).toBeLessThanOrEqual(10);
    expect(text).toBe("高级中文…");
  });

  it("truncates subtitles to the role label width budget", () => {
    const text = formatAgentSubtitleText("高级中文产品经理和自动化工作流负责人");

    expect(measureDisplayUnits(text)).toBeLessThanOrEqual(18);
    expect(text.endsWith("…")).toBe(true);
  });

  it("wraps long CJK speech text into bounded lines", () => {
    const wrapped = wrapTextByDisplayUnits(
      "这是一个很长的中文回复，用来验证角色头顶气泡不会再冲出边框。",
      12,
      3
    );

    expect(wrapped.truncated).toBe(true);
    expect(wrapped.lines).toHaveLength(3);
    expect(wrapped.lines.every((line) => measureDisplayUnits(line) <= 12)).toBe(true);
    expect(wrapped.lines[2]?.endsWith("…")).toBe(true);
  });

  it("builds speech bubble text from markdown with bounded CJK lines", () => {
    const layout = buildSpeechBubbleTextLayout(
      "### 状态更新\n- 已经完成角色气泡修复，并继续验证中文字体显示。"
    );

    expect(layout.text).not.toContain("#");
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.every((line) => measureDisplayUnits(line) <= layout.maxLineUnits)).toBe(true);
  });
});
