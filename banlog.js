// banlog.js
import { Client, GatewayIntentBits, Partials, EmbedBuilder, Events, AuditLogEvent } from "discord.js";

// -----------------------
// CONFIG - NO .env NEEDED
// -----------------------
const TOKEN = "YOUR_BOT_TOKEN_HERE";            // <-- Put your bot token here (string)
const LOG_CHANNEL_ID = "YOUR_LOG_CHANNEL_ID";   // <-- Put the channel ID where logs should be sent
const ADMIN_ROLE_ID = "YOUR_ADMIN_ROLE_ID";     // <-- Put the role ID that should be removed on abuse

const ACTION_LIMIT = 3;                         // limit (more than this triggers removal)
const WINDOW_MS = 60 * 60 * 1000;               // time window (1 hour)

// -----------------------
// CLIENT SETUP
// -----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.User, Partials.Channel]
});

if (!TOKEN || !LOG_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error("[FATAL] TOKEN, LOG_CHANNEL_ID or ADMIN_ROLE_ID not set in code.");
  process.exit(1);
}

// abuseMap: Map<guildId, Map<moderatorId, {count, firstActionTime}>>
const abuseMap = new Map();

client.once(Events.ClientReady, () => {
  console.log(`${client.user.tag} is online!`);
});

// -----------------------
// HELPERS
// -----------------------
async function sendLogEmbed(title, description, fields = [], color = "Orange") {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!ch || !ch.send) {
      console.warn("[WARN] Log channel not found or not sendable:", LOG_CHANNEL_ID);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .addFields(fields)
      .setColor(color)
      .setTimestamp();

    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to send log embed:", err);
  }
}

function incrementAction(guildId, moderatorId) {
  if (!abuseMap.has(guildId)) abuseMap.set(guildId, new Map());
  const guildMap = abuseMap.get(guildId);

  const now = Date.now();
  const entry = guildMap.get(moderatorId) || { count: 0, firstActionTime: now };

  // reset window if expired
  if (now - entry.firstActionTime > WINDOW_MS) {
    entry.count = 0;
    entry.firstActionTime = now;
  }

  entry.count++;
  guildMap.set(moderatorId, entry);

  // cleanup old entries occasionally
  // (optional: could run periodic GC, but map is small)
  return entry.count;
}

async function handleAbuse(guild, moderatorId) {
  try {
    const count = incrementAction(guild.id, moderatorId);

    if (count > ACTION_LIMIT) {
      // Abuse detected: remove role + DM + log
      const member = await guild.members.fetch(moderatorId).catch(() => null);
      if (!member) {
        await sendLogEmbed(
          "⚠️ Anti-Abuse Triggered (member not found)",
          `Moderator with ID \`${moderatorId}\` triggered anti-abuse in guild **${guild.name}** but could not be fetched.`,
          []
        );
        // reset counter for safety
        abuseMap.get(guild.id).delete(moderatorId);
        return;
      }

      // only act if moderator currently has the admin role
      if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
        // still log that threshold was exceeded but role not present
        await sendLogEmbed(
          "⚠️ Anti-Abuse Threshold Reached",
          `${member.user.tag} (${member.id}) exceeded the punishment threshold (${count}) but does not have the monitored admin role.`,
          [
            { name: "Guild", value: guild.name, inline: true },
            { name: "Moderator", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Threshold", value: `${ACTION_LIMIT} per ${WINDOW_MS / (60*1000)} minutes`, inline: true }
          ],
          "Yellow"
        );
        abuseMap.get(guild.id).delete(moderatorId);
        return;
      }

      // remove the admin role
      await member.roles.remove(ADMIN_ROLE_ID, "Auto anti-abuse: exceeded punishment threshold")
        .catch(async err => {
          console.error("Failed removing role:", err);
          await sendLogEmbed(
            "❌ Failed to Remove Admin Role",
            `Could not remove admin role from ${member.user.tag} (${member.id}).`,
            [{ name: "Error", value: String(err).slice(0, 900) }],
            "DarkRed"
          );
        });

      // send DM to moderator
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle("⚠️ Admin Role Removed")
          .setDescription("Your admin role has been removed.")
          .addFields(
            { name: "Reason", value: `You exceeded ${ACTION_LIMIT} kicks/bans/timeouts within 1 hour.`, inline: false },
            { name: "Guild", value: guild.name, inline: true }
          )
          .setColor("DarkRed")
          .setTimestamp();

        await member.send({ embeds: [dmEmbed] }).catch(() => {
          console.warn("Could not send DM to moderator:", member.id);
        });
      } catch (dmErr) {
        console.warn("DM error:", dmErr);
      }

      // send admin action log to configured channel
      await sendLogEmbed(
        "⚠️ Admin Role Removed (Anti-Abuse)",
        `${member.user.tag} (${member.id}) had the admin role removed after exceeding punishment threshold.`,
        [
          { name: "Moderator", value: `${member.user.tag} (${member.id})`, inline: true },
          { name: "Guild", value: guild.name, inline: true },
          { name: "Threshold", value: `${ACTION_LIMIT} per 60 minutes`, inline: true }
        ],
        "DarkRed"
      );

      // reset counter for that moderator in that guild
      abuseMap.get(guild.id).delete(moderatorId);
    }
  } catch (err) {
    console.error("handleAbuse error:", err);
  }
}

// -----------------------
// EVENT HANDLERS
// -----------------------

// Kick: when a member is removed, check audit logs
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const fetched = await member.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberKick }).catch(() => null);
    const entry = fetched?.entries?.first?.() || null;
    if (!entry) return;

    // ensure this audit log matches the removed member
    if (entry.target?.id !== member.id) return;

    const executor = entry.executor;
    await sendLogEmbed(
      "Member Kicked",
      `Target: ${member.user.tag} (${member.id})`,
      [
        { name: "Moderator", value: executor?.tag ?? "Unknown", inline: true },
        { name: "Reason", value: entry.reason ?? "Not specified", inline: true }
      ],
      "Orange"
    );

    if (executor?.id) await handleAbuse(member.guild, executor.id);
  } catch (err) {
    console.error("GuildMemberRemove handler error:", err);
  }
});

// Ban: when a ban is added
client.on(Events.GuildBanAdd, async (ban) => {
  try {
    const fetched = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBanAdd }).catch(() => null);
    const entry = fetched?.entries?.first?.() || null;
    if (!entry) return;

    if (entry.target?.id !== ban.user.id) return;

    const executor = entry.executor;
    await sendLogEmbed(
      "Member Banned",
      `Target: ${ban.user.tag} (${ban.user.id})`,
      [
        { name: "Moderator", value: executor?.tag ?? "Unknown", inline: true },
        { name: "Reason", value: entry.reason ?? "Not specified", inline: true }
      ],
      "Red"
    );

    if (executor?.id) await handleAbuse(ban.guild, executor.id);
  } catch (err) {
    console.error("GuildBanAdd handler error:", err);
  }
});

// Timeout: when a member gets a communicationDisabledUntil (timeout)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    // only when timeout is newly applied
    if (!oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil) {
      const fetched = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberUpdate }).catch(() => null);
      const entry = fetched?.entries?.first?.() || null;
      if (!entry) return;
      if (entry.target?.id !== newMember.id) return;

      const executor = entry.executor;
      await sendLogEmbed(
        "Member Timed Out",
        `Target: ${newMember.user.tag} (${newMember.id})`,
        [
          { name: "Moderator", value: executor?.tag ?? "Unknown", inline: true },
          { name: "Reason", value: entry.reason ?? "Not specified", inline: true }
        ],
        "Orange"
      );

      if (executor?.id) await handleAbuse(newMember.guild, executor.id);
    }
  } catch (err) {
    console.error("GuildMemberUpdate handler error:", err);
  }
});

// -----------------------
// START
// -----------------------
client.login(TOKEN).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});
