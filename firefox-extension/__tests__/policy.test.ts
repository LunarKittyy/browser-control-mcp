import {
  POLICY_PRESETS,
  decide,
  decideAll,
  parsePolicy,
  summarizePolicy,
} from "../acl/policy";

describe("parsePolicy", () => {
  it("parses rules, comments and blank lines", () => {
    const policy = parsePolicy(`
      # comment
      allow see, manage on *   # trailing comment
      hide on site:bank.se
    `);
    expect(policy.errors).toEqual([]);
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules[0].verb).toBe("allow");
    expect([...policy.rules[0].capabilities]).toEqual(["see", "manage"]);
    expect(policy.rules[1].verb).toBe("hide");
  });

  it("reports errors with line numbers and keeps the valid rules", () => {
    const policy = parsePolicy(
      [
        "allow read on *",
        "permit read on *",
        "allow read site:x.com",
        "allow fly on *",
        'allow read on group:"unterminated',
        "allow read on",
        "allow read on nonsense",
        "ask manage on *",
        "hide read on *",
      ].join("\n")
    );
    expect(policy.rules).toHaveLength(1);
    expect(policy.errors.map((error) => error.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(policy.errors[2].message).toMatch(/Unknown capability "fly"/);
  });

  it("expands all and bookmarks", () => {
    const [all, bookmarks] = parsePolicy("allow all on *\nallow bookmarks on *").rules;
    expect(all.capabilities.size).toBe(9);
    expect([...bookmarks.capabilities]).toEqual(["bookmarks.read", "bookmarks.write"]);
  });

  it("lets 'ask all' through, dropping capabilities that can't be asked", () => {
    const policy = parsePolicy("ask all on *");
    expect(policy.errors).toEqual([]);
    expect([...policy.rules[0].capabilities].sort()).toEqual(
      ["interact", "read", "screenshot", "selection"]
    );
  });

  it("parses every preset without errors", () => {
    for (const preset of Object.values(POLICY_PRESETS)) {
      expect(parsePolicy(preset).errors).toEqual([]);
    }
  });
});

describe("decide", () => {
  const policy = parsePolicy(`
    allow see, manage, read on *
    ask interact on *
    allow interact on site:ikea.com
    deny read on group:"Work*"
    hide on site:swedbank.se
    hide on group:"Private*"
    hide on private
    allow bookmarks.write on folder:"Agent/**"
    allow bookmarks.read on folder:/toolbar/**
  `);

  it("denies what no rule allows", () => {
    expect(decide(policy, { url: "https://example.com" }, "screenshot")).toBe("deny");
  });

  it("lets later rules override earlier ones", () => {
    expect(decide(policy, { url: "https://example.com" }, "interact")).toBe("ask");
    expect(decide(policy, { url: "https://www.ikea.com/se" }, "interact")).toBe("allow");
    expect(decide(policy, { url: "https://a.com", groupTitle: "Work stuff" }, "read")).toBe("deny");
    expect(decide(policy, { url: "https://a.com", groupTitle: "Work stuff" }, "manage")).toBe("allow");
  });

  it("matches bare domains including subdomains, but not lookalikes", () => {
    expect(decide(policy, { url: "https://ikea.com/" }, "interact")).toBe("allow");
    expect(decide(policy, { url: "https://shop.ikea.com/" }, "interact")).toBe("allow");
    expect(decide(policy, { url: "https://notikea.com/" }, "interact")).toBe("ask");
  });

  it("makes hide win regardless of order", () => {
    const reordered = parsePolicy("hide on site:bank.se\nallow all on *");
    expect(decide(reordered, { url: "https://www.bank.se" }, "see")).toBe("hidden");
    expect(decide(policy, { url: "https://internetbank.swedbank.se" }, "manage")).toBe("hidden");
    expect(decide(policy, { url: "https://x.com", groupTitle: "private notes" }, "see")).toBe("hidden");
    expect(decide(policy, { url: "https://x.com", incognito: true }, "see")).toBe("hidden");
  });

  it("supports negation and AND of selectors", () => {
    const negated = parsePolicy(`
      allow read on *
      deny read on !group:"Research*"
      allow interact on site:github.com group:"Research*"
    `);
    expect(decide(negated, { url: "https://a.com", groupTitle: "Research: GPUs" }, "read")).toBe("allow");
    expect(decide(negated, { url: "https://a.com" }, "read")).toBe("deny");
    expect(decide(negated, { url: "https://github.com", groupTitle: "Research" }, "interact")).toBe("allow");
    expect(decide(negated, { url: "https://github.com" }, "interact")).toBe("deny");
  });

  it("matches url globs, containers and agent tabs", () => {
    const rules = parsePolicy(`
      allow read on url:https://github.com/me/*
      hide on container:"Bank*"
      allow interact on agent
    `);
    expect(decide(rules, { url: "https://github.com/me/repo" }, "read")).toBe("allow");
    expect(decide(rules, { url: "https://github.com/other" }, "read")).toBe("deny");
    expect(decide(rules, { url: "https://a.com", container: "banking" }, "see")).toBe("hidden");
    expect(decide(rules, { url: "https://a.com", openedByAgent: true }, "interact")).toBe("allow");
  });

  it("matches folder patterns anywhere or anchored", () => {
    expect(decide(policy, { folderPath: "other/Agent" }, "bookmarks.write")).toBe("allow");
    expect(decide(policy, { folderPath: "other/Agent/GPUs" }, "bookmarks.write")).toBe("allow");
    expect(decide(policy, { folderPath: "other/Agents" }, "bookmarks.write")).toBe("deny");
    expect(decide(policy, { folderPath: "toolbar/News" }, "bookmarks.read")).toBe("allow");
    expect(decide(policy, { folderPath: "menu/toolbar" }, "bookmarks.read")).toBe("deny");
  });

  it("ignores folder rules for tabs and tab rules without context", () => {
    expect(decide(policy, { url: "https://a.com" }, "bookmarks.write")).toBe("deny");
    expect(decide(parsePolicy('allow read on group:"*"'), { url: "https://a.com" }, "read")).toBe("deny");
  });
});

describe("summaries", () => {
  it("describes rules in plain words", () => {
    const summary = summarizePolicy(
      parsePolicy("allow read, manage on site:ikea.com\nhide on private")
    );
    expect(summary[0]).toBe("Allowed: read, manage on site ikea.com (and subdomains).");
    expect(summary[1]).toBe("Hidden from the agent entirely: private windows.");
  });

  it("decides every capability at once", () => {
    const decisions = decideAll(parsePolicy(POLICY_PRESETS.balanced), {
      url: "https://example.com",
    });
    expect(decisions.read).toBe("allow");
    expect(decisions.interact).toBe("ask");
    expect(decisions["bookmarks.write"]).toBe("deny");
  });
});
