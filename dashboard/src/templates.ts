// Starting points for a new agent, adapted from the website's use cases
// (site/src/use-cases.ts). Everything is editable before saving.

export interface AgentTemplate {
  id: string;
  title: string;
  blurb: string;
  name: string;
  company: string;
  instructions: string;
  first_message: string;
  /** Call context to try it with (shown in the test-call dialog). */
  context: Record<string, string>;
}

export const TEMPLATES: AgentTemplate[] = [
  {
    id: "appointments",
    title: "Confirm appointments",
    blurb: "Call the day before, confirm or move the time, and note anything for the clinic.",
    name: "Alex",
    company: "Acme Clinic",
    instructions:
      "You are confirming a patient's appointment from the call context. If they can't make it, offer the open slots one or two at a time and confirm the one they pick. Record kept_original_time as yes or no, new_time if they move it, and notes for anything they ask you to pass on. Don't give medical advice.",
    first_message: "Hi, this is Alex from Acme Clinic. I'm calling about your appointment with Dr. Rao. Is now a good time?",
    context: { appointment: "Tuesday 3 PM with Dr. Rao", open_slots: "Wednesday 10 AM, Wednesday 2:30 PM" },
  },
  {
    id: "screening",
    title: "Screen candidates",
    blurb: "Follow up an application, check interest, notice period and pay, and book an interview.",
    name: "Sam",
    company: "Northwind",
    instructions:
      "You are following up a job application. Confirm the candidate is still interested, then ask their notice period and salary expectation, one question at a time. If they're interested, offer one of the interview slots in the call context and confirm the one they choose. Record interested, notice_period, salary_expectation and interview_slot. Be warm and brief, and don't negotiate salary.",
    first_message: "Hi, this is Sam from Northwind. You applied for our backend engineer role last week. Do you have two minutes to talk about it?",
    context: { role: "Backend engineer, remote", interview_slots: "Thursday 11 AM, Friday 10 AM" },
  },
  {
    id: "leads",
    title: "Qualify leads",
    blurb: "Call back a demo request, learn what they need, and book a demo with the right ones.",
    name: "Riya",
    company: "Brightdesk",
    instructions:
      "You are calling back someone who requested a demo of Brightdesk, a help desk tool. Ask what problem they want to solve, how big their support team is, and when they hope to decide, one question at a time. If they have a real need, offer a demo slot from the call context. Record need, team_size, timeline and demo_booked. Don't quote prices; say the demo will cover them.",
    first_message: "Hi, this is Riya from Brightdesk. You asked for a demo on our website yesterday. Do you have a couple of minutes?",
    context: { demo_slots: "Tuesday 2 PM, Wednesday 11 AM" },
  },
];

export const BLANK: AgentTemplate = {
  id: "blank",
  title: "Start from scratch",
  blurb: "Write your own instructions.",
  name: "",
  company: "",
  instructions: "",
  first_message: "",
  context: {},
};
