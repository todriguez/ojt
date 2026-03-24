/**
 * channelService.ts
 *
 * Universal CRUD for participants, channels, and channel policies.
 * Vertical-agnostic — speaks of "participants", "channels", "policies".
 * No trades vernacular here.
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  participants,
  channels,
  channelPolicies,
  accessPolicies,
  objectEdges,
  semanticObjects,
} from "./schema.core";
import { createLogger } from "@/lib/logger";

const log = createLogger("channel-service");

// ── Constant: AI assistant pseudo-participant ──
const AI_IDENTITY_REF = "ai:assistant";
const AI_IDENTITY_KIND = "ai" as const;

// ─────────────────────────────────────────────
// Participants
// ─────────────────────────────────────────────

export interface AddParticipantInput {
  objectId: string;
  identityRef: string;
  identityKind: "customer" | "admin" | "operator" | "external" | "ai";
  participantRole: "creator" | "contributor" | "approver" | "observer" | "executor";
  displayName?: string;
  invitedBy?: string;
}

export async function addParticipant(input: AddParticipantInput) {
  const db = await getDb();

  // Check if already exists
  const existing = await db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.objectId, input.objectId),
        eq(participants.identityRef, input.identityRef),
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [participant] = await db
    .insert(participants)
    .values({
      objectId: input.objectId,
      identityRef: input.identityRef,
      identityKind: input.identityKind,
      participantRole: input.participantRole,
      displayName: input.displayName,
      invitedBy: input.invitedBy,
      joinedAt: new Date(),
    })
    .returning();

  log.info(
    { objectId: input.objectId, identity: input.identityRef, role: input.participantRole },
    "participant.added"
  );

  return participant;
}

export async function getParticipants(objectId: string) {
  const db = await getDb();
  return db
    .select()
    .from(participants)
    .where(eq(participants.objectId, objectId));
}

export async function findParticipant(objectId: string, identityRef: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(participants)
    .where(
      and(
        eq(participants.objectId, objectId),
        eq(participants.identityRef, identityRef),
      )
    )
    .limit(1);
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// Channels
// ─────────────────────────────────────────────

export interface CreateChannelInput {
  objectId: string;
  participantIds: string[];
  channelKind?: "participant_pair" | "group" | "system";
  label?: string;
}

export async function createChannel(input: CreateChannelInput) {
  const db = await getDb();
  const kind = input.channelKind || "participant_pair";

  // Create an objectEdge for this channel relationship
  const [edge] = await db
    .insert(objectEdges)
    .values({
      fromObjectId: input.objectId,
      toObjectId: input.objectId, // self-referential — channel is on this object
      edgeType: "channel",
      edgePayload: { participantIds: input.participantIds, label: input.label },
    })
    .returning();

  const [channel] = await db
    .insert(channels)
    .values({
      objectId: input.objectId,
      channelKind: kind,
      label: input.label,
      participantIds: input.participantIds,
      edgeId: edge.id,
    })
    .returning();

  log.info(
    { objectId: input.objectId, channelId: channel.id, kind, label: input.label },
    "channel.created"
  );

  return channel;
}

/**
 * Create a participant + their default AI channel in one operation.
 * This is the common case: a new participant joins and gets a conversation with the AI.
 */
export async function addParticipantWithChannel(input: AddParticipantInput) {
  const db = await getDb();

  // 1. Add the participant
  const participant = await addParticipant(input);

  // 2. Ensure AI participant exists on this object
  const aiParticipant = await addParticipant({
    objectId: input.objectId,
    identityRef: AI_IDENTITY_REF,
    identityKind: AI_IDENTITY_KIND,
    participantRole: "observer",
    displayName: "AI Assistant",
  });

  // 3. Create the channel
  const channel = await createChannel({
    objectId: input.objectId,
    participantIds: [participant.id, aiParticipant.id],
    channelKind: "participant_pair",
    label: `${input.displayName || input.identityRef} ↔ AI`,
  });

  return { participant, channel, aiParticipant };
}

export async function getChannelsForObject(objectId: string) {
  const db = await getDb();
  return db
    .select()
    .from(channels)
    .where(eq(channels.objectId, objectId));
}

export async function getChannelForParticipant(objectId: string, identityRef: string) {
  const db = await getDb();

  // Find the participant
  const participant = await findParticipant(objectId, identityRef);
  if (!participant) return null;

  // Find a channel that includes this participant
  const allChannels = await getChannelsForObject(objectId);
  return allChannels.find((ch) => {
    const ids = ch.participantIds as string[];
    return ids.includes(participant.id);
  }) || null;
}

export async function getChannel(channelId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// Channel Policies
// ─────────────────────────────────────────────

export interface AssignChannelPolicyInput {
  channelId: string;
  participantId: string;
  policyId: string;
  fieldOverrides?: Record<string, string>;
}

export async function assignChannelPolicy(input: AssignChannelPolicyInput) {
  const db = await getDb();

  const [policy] = await db
    .insert(channelPolicies)
    .values({
      channelId: input.channelId,
      policyId: input.policyId,
      participantId: input.participantId,
      fieldOverrides: input.fieldOverrides || null,
    })
    .returning();

  log.info(
    { channelId: input.channelId, participantId: input.participantId, policyId: input.policyId },
    "channel-policy.assigned"
  );

  return policy;
}

export async function getChannelPolicy(channelId: string, participantId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      channelPolicy: channelPolicies,
      accessPolicy: accessPolicies,
    })
    .from(channelPolicies)
    .innerJoin(accessPolicies, eq(channelPolicies.policyId, accessPolicies.id))
    .where(
      and(
        eq(channelPolicies.channelId, channelId),
        eq(channelPolicies.participantId, participantId),
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return {
    ...rows[0].channelPolicy,
    policy: rows[0].accessPolicy,
  };
}

// ─────────────────────────────────────────────
// Access Policy Templates
// ─────────────────────────────────────────────

export async function getActivePolicyTemplate(vertical: string, name: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(accessPolicies)
    .where(
      and(
        eq(accessPolicies.vertical, vertical),
        eq(accessPolicies.name, name),
        eq(accessPolicies.isTemplate, true),
        eq(accessPolicies.isActive, true),
      )
    )
    .limit(1);
  return rows[0] || null;
}

export async function upsertPolicyTemplate(input: {
  vertical: string;
  name: string;
  version: number;
  roleRules: any;
  overrideHierarchy: any;
  aiContextFilter: any;
  changeNotes?: string;
}) {
  const db = await getDb();

  // Check if this version already exists
  const existing = await db
    .select()
    .from(accessPolicies)
    .where(
      and(
        eq(accessPolicies.vertical, input.vertical),
        eq(accessPolicies.name, input.name),
        eq(accessPolicies.version, input.version),
      )
    )
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [policy] = await db
    .insert(accessPolicies)
    .values({
      vertical: input.vertical,
      name: input.name,
      version: input.version,
      roleRules: input.roleRules,
      overrideHierarchy: input.overrideHierarchy,
      aiContextFilter: input.aiContextFilter,
      isTemplate: true,
      isActive: true,
      createdBy: "system",
      changeNotes: input.changeNotes || `Initial v${input.version}`,
    })
    .returning();

  return policy;
}
