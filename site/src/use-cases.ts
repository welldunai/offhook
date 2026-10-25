// The launch use cases. The live demo (DEMO.md, M3) reuses these definitions, so the
// agent config here is what a visitor will actually talk to. Companies are fictional.

export interface Turn {
  who: "agent" | "person";
  text: string;
}

export interface UseCase {
  slug: string;
  title: string; // the job, in the visitor's words
  team: string; // who makes these calls today
  chip: string; // short label for the example chip
  tint: "peach" | "blue" | "mint" | "lavender" | "yellow"; // its colour family
  summary: string; // one line for the card
  purpose: string; // the plain-English brief a visitor would type for this call
  agent: { name: string; company: string; role: string };
  person: string; // who the visitor plays in the demo
  brief: string; // what the visitor is told before a demo call
  goal: string; // what the agent is trying to do, in plain words
  instructions: string; // the agent's instructions (sent as-is to Offhook)
  firstMessage: string;
  context: Record<string, string>; // facts the agent knows for this call
  fields: { key: string; label: string; example: string }[]; // what the agent records
  sample: Turn[];
  outcome: Record<string, string | boolean>;
}

export const USE_CASES: UseCase[] = [
  {
    slug: "recruiter-screening",
    chip: "Screen a candidate",
    tint: "lavender",
    title: "Screen candidates",
    team: "Recruiting",
    summary: "Follow up every application within the hour, check the basics, and book interviews with the people who fit.",
    purpose: "Call candidates who applied for our backend engineer role. Check they're still interested, ask their notice period and salary expectations, and book an interview.",
    agent: { name: "Sam", company: "Northwind", role: "recruiter" },
    person: "the candidate",
    brief: "You applied for the backend engineer role at Northwind last week. You're interested, but you have a 60-day notice period. Say what you'd say on a real call.",
    goal: "Confirm the candidate is still interested, then ask about notice period and salary expectations, and offer an interview slot.",
    instructions:
      "You are following up on a job application for the Backend Engineer role. Confirm the candidate is still interested. Ask their notice period and salary expectation, one question at a time. If they are interested, offer one of the interview slots in the call context and confirm the one they choose. Record each answer with record_result. Be warm and brief, and don't negotiate salary.",
    firstMessage: "Hi, this is Sam from Northwind. You applied for our backend engineer role last week. Do you have two minutes to talk about it?",
    context: {
      role: "Backend Engineer, Python and Postgres, fully remote",
      interview_slots: "Thursday 11 AM, Thursday 4 PM, Friday 10 AM",
    },
    fields: [
      { key: "interested", label: "Still interested", example: "true" },
      { key: "notice_period", label: "Notice period", example: "60 days" },
      { key: "salary_expectation", label: "Salary expectation", example: "Around 150k" },
      { key: "interview_slot", label: "Interview slot", example: "Friday 10 AM" },
    ],
    sample: [
      { who: "agent", text: "Hi, this is Sam from Northwind. You applied for our backend engineer role last week. Do you have two minutes to talk about it?" },
      { who: "person", text: "Sure, yeah. I'm still interested." },
      { who: "agent", text: "Great to hear. What's your notice period at your current job?" },
      { who: "person", text: "It's sixty days, unfortunately." },
      { who: "agent", text: "Got it, sixty days is fine for this role. And what salary range are you looking for?" },
      { who: "person", text: "Somewhere around one fifty." },
      { who: "agent", text: "Thanks. I can set up an interview with the team. Would Thursday at eleven, Thursday at four, or Friday at ten work?" },
      { who: "person", text: "Friday at ten is best." },
      { who: "agent", text: "Friday at ten it is. You'll get a calendar invite by email today. Thanks for your time!" },
    ],
    outcome: { interested: true, notice_period: "60 days", salary_expectation: "Around 150k", interview_slot: "Friday 10 AM" },
  },
  {
    slug: "appointment-confirmation",
    chip: "Confirm an appointment",
    tint: "blue",
    title: "Confirm appointments",
    team: "Front desk",
    summary: "Call patients the day before, confirm or reschedule, and free up slots that would otherwise go empty.",
    purpose: "Call patients the day before their appointment to confirm it. If they can't make it, offer another open slot and note anything they want the clinic to know.",
    agent: { name: "Alex", company: "Acme Clinic", role: "front desk assistant" },
    person: "the patient",
    brief: "You have an appointment at Acme Clinic with Dr. Rao on Tuesday at 3 PM. Something has come up, so you'd like to move it. Say what you'd say on a real call.",
    goal: "Confirm tomorrow's appointment, or find a new time from the open slots if the patient can't make it.",
    instructions:
      "You are confirming a patient's appointment. Confirm the date, time and doctor from the call context. If the patient can't make it, offer the open slots in the call context, one or two at a time, and confirm the one they pick. Record whether they confirmed, any new time, and anything they ask you to pass on. Don't give medical advice.",
    firstMessage: "Hi, this is Alex from Acme Clinic. I'm calling about your appointment with Dr. Rao. Is now a good time?",
    context: {
      patient_name: "Priya",
      appointment: "Tuesday at 3 PM with Dr. Rao",
      open_slots: "Wednesday 10 AM, Wednesday 2:30 PM, Thursday 9 AM",
    },
    fields: [
      { key: "confirmed", label: "Kept the original time", example: "false" },
      { key: "new_time", label: "New time", example: "Wednesday 2:30 PM" },
      { key: "notes", label: "Notes for the clinic", example: "Asked for a reminder text" },
    ],
    sample: [
      { who: "agent", text: "Hi, this is Alex from Acme Clinic. I'm calling about your appointment with Dr. Rao. Is now a good time?" },
      { who: "person", text: "Yes, go ahead." },
      { who: "agent", text: "You're booked for Tuesday at three. Does that still work for you?" },
      { who: "person", text: "Actually, no. Something came up at work. Can we move it?" },
      { who: "agent", text: "Of course. I have Wednesday at ten in the morning or two thirty in the afternoon. Would either of those work?" },
      { who: "person", text: "Two thirty on Wednesday is good. Can you text me a reminder?" },
      { who: "agent", text: "Done. You're now booked for Wednesday at two thirty with Dr. Rao, and I've noted that you'd like a reminder text. Anything else?" },
      { who: "person", text: "No, that's all. Thanks!" },
    ],
    outcome: { confirmed: false, new_time: "Wednesday 2:30 PM", notes: "Asked for a reminder text" },
  },
  {
    slug: "lead-qualification",
    chip: "Qualify a lead",
    tint: "mint",
    title: "Qualify leads",
    team: "Sales",
    summary: "Call back every demo request while it's still warm, learn what they need, and book the right ones with your team.",
    purpose: "Call people who asked for a demo of our help desk tool. Find out what they need, their team size and timeline, and book a demo if it's a good fit.",
    agent: { name: "Riya", company: "Brightdesk", role: "sales development rep" },
    person: "the lead",
    brief: "You asked for a demo of Brightdesk, a help desk tool, on its website yesterday. Your support team of eight is outgrowing shared inboxes. Say what you'd say on a real call.",
    goal: "Find out what the lead needs, how big their team is and when they want to decide, then book a demo if it's a fit.",
    instructions:
      "You are calling back someone who requested a demo of Brightdesk, a help desk tool. Thank them for their interest. Ask what problem they want to solve, how big their support team is, and when they hope to decide, one question at a time. If they have a real need, offer to book a demo using the slots in the call context. Record each answer with record_result. Don't quote prices; say the demo will cover them.",
    firstMessage: "Hi, this is Riya from Brightdesk. You asked for a demo on our website yesterday. Do you have a couple of minutes?",
    context: {
      product: "Brightdesk, a help desk for support teams",
      demo_slots: "Monday 2 PM, Tuesday 11 AM, Tuesday 3 PM",
    },
    fields: [
      { key: "need", label: "What they need", example: "Replace shared inbox" },
      { key: "team_size", label: "Team size", example: "8" },
      { key: "timeline", label: "Timeline", example: "This quarter" },
      { key: "demo_booked", label: "Demo booked", example: "Tuesday 11 AM" },
    ],
    sample: [
      { who: "agent", text: "Hi, this is Riya from Brightdesk. You asked for a demo on our website yesterday. Do you have a couple of minutes?" },
      { who: "person", text: "Yes, I do." },
      { who: "agent", text: "Thanks. What made you look at a help desk tool right now?" },
      { who: "person", text: "We answer everything from a shared inbox and things keep slipping through." },
      { who: "agent", text: "That's a common reason. How many people are on your support team?" },
      { who: "person", text: "Eight, and we're hiring two more." },
      { who: "agent", text: "And when are you hoping to have something in place?" },
      { who: "person", text: "Ideally this quarter." },
      { who: "agent", text: "That sounds like a good fit. I can book a demo with our team on Monday at two, or Tuesday at eleven or three. Which suits you?" },
      { who: "person", text: "Tuesday at eleven." },
      { who: "agent", text: "You're booked for Tuesday at eleven. You'll get an invite shortly, and the demo will cover pricing too. Thanks!" },
    ],
    outcome: { need: "Replace shared inbox", team_size: "8", timeline: "This quarter", demo_booked: "Tuesday 11 AM" },
  },
];

export const useCaseBySlug = Object.fromEntries(USE_CASES.map((u) => [u.slug, u])) as Record<string, UseCase>;

/** How a recorded value reads on the page: booleans as Yes / No. */
export const showValue = (v: string | boolean | undefined) => (v === true ? "Yes" : v === false ? "No" : String(v ?? ""));
