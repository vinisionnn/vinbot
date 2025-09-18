const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
require("dotenv").config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const token = process.env.DISCORD_TOKEN;
const logChannelId = process.env.LOG_ID;

client.on("ready", async () => {
    console.log(`${client.user.tag} giriş yaptı!`);

    try {
        const logChannel = await client.channels.fetch(logChannelId);
        if (!logChannel) return console.log("Log kanalı bulunamadı.");

        const embed = new EmbedBuilder()
            .setTitle("✅ Test Log Mesajı")
            .setDescription("Bu mesaj, botun log kanalına mesaj gönderebildiğini test etmek için atıldı.")
            .setColor("Green")
            .setTimestamp();

        await logChannel.send({ embeds: [embed] });
        console.log("Test mesajı log kanalına gönderildi!");
    } catch (err) {
        console.error("Log kanalı mesaj gönderme hatası:", err);
    }
});

client.login(token);
