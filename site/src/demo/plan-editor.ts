// Editing a planned call before it starts (DEMO.md: "every part of it can be edited").
// Limits match the Worker's (demo/worker/src/plan.ts), so an edited plan that
// passes here passes there too.
import type { Plan } from "./client";

const MAX = { name: 40, company: 60, role: 60, person: 60, brief: 400, goal: 300, firstMessage: 300, instructions: 1500, label: 40, factKey: 40, factValue: 200 };
const MAX_FIELDS = 5;
const MAX_FACTS = 6;

/**
 * Builds an edit form for `plan`.
 * Args: plan — the plan to edit; onSave — gets the edited plan; onCancel — called on Cancel.
 * Returns: the form element, ready to insert.
 */
export function planEditor(plan: Plan, onSave: (plan: Plan) => void, onCancel: () => void): HTMLFormElement {
  const form = el("form", { className: "plan-edit", noValidate: true });
  const problem = el("p", { className: "plan-edit-problem", hidden: true });
  problem.setAttribute("role", "alert");

  const agent = row("The agent", [
    labelled("Name", input("name", "Name", plan.agent.name, MAX.name)),
    labelled("Company", input("company", "Company", plan.agent.company, MAX.company)),
    labelled("Role", input("role", "Role", plan.agent.role, MAX.role)),
  ]);
  const opens = row("Opens with", [area("firstMessage", "Opening line", plan.firstMessage, MAX.firstMessage, 2)]);
  const goal = row("Goal", [area("goal", "Goal", plan.goal, MAX.goal, 2)]);

  const fieldList = el("ul", { className: "plan-edit-list" });
  const addField = (label = "", key = "") => {
    const li = el("li");
    li.dataset.key = key;
    const box = input("", "Thing to write down", label, MAX.label);
    const remove = el("button", { type: "button", className: "wd-btn wd-btn--ghost wd-btn--sm", textContent: "Remove" });
    remove.addEventListener("click", () => {
      li.remove();
      sync();
    });
    li.append(box, remove);
    fieldList.append(li);
    sync();
  };
  const addButton = el("button", { type: "button", className: "wd-btn wd-btn--ghost wd-btn--sm", textContent: "Add another" });
  addButton.addEventListener("click", () => addField());
  const sync = () => (addButton.hidden = fieldList.children.length >= MAX_FIELDS);
  plan.fields.forEach((f) => addField(f.label, f.key));
  const fields = row("Writes down", [fieldList, addButton]);

  const facts = row("Made up for the call", [
    area("facts", "One per line, like: delivery date: Monday 26 October", Object.entries(plan.assumptions).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n"), 1500, 3),
  ]);
  const brief = row("You play", [area("brief", "Who you play", plan.brief, MAX.brief, 3), labelled("Who you are, in a few words", input("person", "Who you are, in a few words", plan.person, MAX.person))]);
  const more = el("details", { className: "plan-edit-more" });
  more.append(el("summary", { textContent: "The agent's instructions" }), area("instructions", "Instructions", plan.instructions, MAX.instructions, 6));

  const save = el("button", { type: "submit", className: "wd-btn wd-btn--primary", textContent: "Save the plan" });
  const cancel = el("button", { type: "button", className: "wd-btn wd-btn--secondary", textContent: "Cancel" });
  cancel.addEventListener("click", onCancel);
  const actions = el("div", { className: "plan-actions" });
  actions.append(save, cancel);

  form.append(agent, opens, goal, fields, facts, brief, more, problem, actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = read(form, plan);
    if (typeof result === "string") {
      problem.textContent = result;
      problem.hidden = false;
      return;
    }
    onSave(result);
  });
  return form;
}

/**
 * Reads the form back into a plan.
 * Args: form — from planEditor; original — the plan being edited (keeps field keys stable).
 * Returns: the edited plan, or a message saying what to fix.
 */
function read(form: HTMLFormElement, original: Plan): Plan | string {
  const v = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value.trim().replace(/[ \t]+/g, " ");
  const required: [string, string][] = [["name", "the agent's name"], ["company", "the company"], ["role", "the role"], ["firstMessage", "the opening line"], ["goal", "the goal"], ["brief", "who you play"], ["person", "who you are"], ["instructions", "the instructions"]];
  for (const [name, what] of required) if (!v(name)) return `Add ${what}.`;

  const taken = new Set<string>();
  const fields = [...form.querySelectorAll<HTMLLIElement>(".plan-edit-list li")]
    .map((li) => ({ label: li.querySelector("input")!.value.trim(), key: li.dataset.key ?? "" }))
    .filter((f) => f.label)
    .map((f) => {
      let key = f.key || slug(f.label);
      for (let i = 2; taken.has(key); i++) key = `${slug(f.label).slice(0, 36)}_${i}`;
      taken.add(key);
      return { key, label: f.label };
    });
  if (!fields.length) return "Add at least one thing for the agent to write down.";

  const assumptions: Record<string, string> = {};
  for (const line of v("facts").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(":");
    if (at < 1) return `Write each made-up fact as "name: value" ("${line.slice(0, 30)}").`;
    const key = slug(line.slice(0, at));
    const value = line.slice(at + 1).trim();
    if (!key || !value) return `Write each made-up fact as "name: value" ("${line.slice(0, 30)}").`;
    if (key.length > MAX.factKey || value.length > MAX.factValue) return "One of the made-up facts is too long.";
    assumptions[key] = value;
  }
  if (Object.keys(assumptions).length > MAX_FACTS) return `Keep it to ${MAX_FACTS} made-up facts.`;

  return {
    ...original,
    agent: { name: v("name"), company: v("company"), role: v("role") },
    firstMessage: v("firstMessage"),
    goal: v("goal"),
    brief: v("brief"),
    person: v("person"),
    instructions: v("instructions"),
    fields,
    assumptions,
  };
}

/** "New delivery day" → "new_delivery_day" (the Worker's key format). */
function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) ? s : `f_${s}`.slice(0, 40);
}

/** A labelled row, like the plan card's. */
function row(title: string, children: HTMLElement[]): HTMLElement {
  const div = el("div", { className: "plan-edit-row" });
  div.append(el("span", { className: "plan-edit-title", textContent: title }), ...children);
  return div;
}

/** Wraps a control with a visible label (placeholders vanish once there's text). */
function labelled(text: string, control: HTMLInputElement): HTMLLabelElement {
  const label = el("label", { className: "plan-edit-field" });
  label.append(el("span", { textContent: text }), control);
  control.removeAttribute("aria-label");
  return label;
}

function input(name: string, label: string, value: string, max: number): HTMLInputElement {
  const i = el("input", { type: "text", name, value, maxLength: max, placeholder: label });
  i.setAttribute("aria-label", label);
  return i;
}

function area(name: string, label: string, value: string, max: number, rows: number): HTMLTextAreaElement {
  const t = el("textarea", { name, value, maxLength: max, rows, placeholder: label });
  t.setAttribute("aria-label", label);
  return t;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}
