"use server";

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const segmentId = process.env.RESEND_SEGMENT_ID!;

export async function joinWaitlist(
  email: string,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Please enter a valid email address." };
  }

  try {
    await resend.contacts.create({
      email,
      segments: [{ id: segmentId }],
    });
    return { success: true };
  } catch (err) {
    console.error("Waitlist signup error:", err);
    return { success: false, error: "Something went wrong. Please try again." };
  }
}
