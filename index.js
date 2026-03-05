const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    getVoiceConnection,
    entersState
} = require('@discordjs/voice');
const play = require('play-dl');

// ─── Bot Yapılandırması ───
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const queue = new Map();

/**
 * SES KANALINA BAĞLANMA
 */
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;
    let connection = getVoiceConnection(guildId);

    if (connection) {
        if (connection.joinConfig.channelId !== channel.id) {
            connection.destroy();
        } else {
            return connection;
        }
    }

    console.log(`🔌 [BAĞLANTI] #${channel.name} kanalına bağlanılıyor...`);
    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
    });

    const timeout = setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            console.log('⚠️ [AĞ HATASI] Bağlantı sıfırlanıyor...');
            connection.destroy();
            setTimeout(() => manageVoiceConnection(channel), 2000);
        }
    }, 15000);

    connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready) {
            clearTimeout(timeout);
            console.log('✅ [HAZIR] Ses bağlantısı kuruldu!');
        }
    });

    return connection;
}

/**
 * ŞARKI OYNATMA
 */
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) return finalizeQueue(guildId);

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Hazırlanıyor: ${song.title}`);
        let stream = await play.stream(song.url, { discordPlayerCompatibility: true, quality: 2 });
        const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
        resource.volume.setVolume(serverQueue.volume / 100);

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);
        console.log(`✅ [PLAYING] ${song.title}`);
    } catch (err) {
        console.error('❌ Oynatma Hatası:', err.message);
        serverQueue.songs.shift();
        playSong(guildId, interaction);
    }
}

async function finalizeQueue(guildId) {
    const serverQueue = queue.get(guildId);
    const waitCID = process.env.WAIT_CHANNEL_ID;
    const waitGID = process.env.WAIT_GUILD_ID;
    if (waitCID && waitGID && guildId === waitGID) {
        try {
            const g = await client.guilds.fetch(waitGID);
            const c = await g.channels.fetch(waitCID);
            if (c) manageVoiceConnection(c);
        } catch (e) { console.error(e); }
    } else {
        if (serverQueue && serverQueue.connection) serverQueue.connection.destroy();
    }
    queue.delete(guildId);
}

// ─── Slash Komutları (Hatasız Sürüm) ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Botu ses kanalına çağırır.'),
    new SlashCommandBuilder().setName('cal').setDescription('YouTube bağlantısı ile müzik çalar.').addStringOption(o => o.setName('link').setDescription('YouTube Video Linki').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Müziği duraklatır.'),
    new SlashCommandBuilder().setName('devam').setDescription('Müziği devam ettirir.'),
    new SlashCommandBuilder().setName('atla').setDescription('Sıradaki şarkıya geçer.'),
    new SlashCommandBuilder().setName('git').setDescription('Kanalı terk eder.'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses seviyesini ayarlar.').addIntegerOption(o => o.setName('seviye').setDescription('Seviye (1-100)').setRequired(true)),
    new SlashCommandBuilder().setName('kuyruk').setDescription('Şarkı listesini gösterir.'),
].map(c => c.toJSON());

client.once('clientReady', async () => {
    console.log(`🚀 [AKTİF] ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }], status: 'online' });
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Komutlar başarıyla kaydedildi.');
    } catch (error) {
        console.error('❌ Komut kaydı hatası:', error);
    }
    setTimeout(async () => {
        const wCID = process.env.WAIT_CHANNEL_ID;
        const wGID = process.env.WAIT_GUILD_ID;
        if (wCID && wGID) {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c) manageVoiceConnection(c);
            } catch (e) { }
        }
    }, 10000);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = interaction;
    if (commandName === 'cal') {
        const vChannel = member.voice.channel;
        if (!vChannel) return interaction.reply({ content: '❌ Sese girmelisin!', ephemeral: true });
        const url = interaction.options.getString('link');
        await interaction.deferReply();
        try {
            const songInfo = await play.video_info(url);
            const song = { title: songInfo.video_details.title, url: url };
            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                const connection = manageVoiceConnection(vChannel);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
                player.on('stateChange', (o, n) => {
                    if (n.status === AudioPlayerStatus.Idle) { sQueue.songs.shift(); playSong(guild.id, interaction); }
                    if (n.status === AudioPlayerStatus.AutoPaused) player.unpause();
                });
                sQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, sQueue);
                await interaction.editReply(`🎵 Çalınıyor: **${song.title}**`);
                try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); playSong(guild.id, interaction); } catch { playSong(guild.id, interaction); }
            } else {
                sQueue.songs.push(song);
                await interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
            }
        } catch (e) { await interaction.editReply(`❌ Hata: ${e.message}`); }
    }
    if (commandName === 'dur') { const q = queue.get(guild.id); if (q) { q.player.pause(); await interaction.reply('⏸️ Durduruldu.'); } }
    if (commandName === 'devam') { const q = queue.get(guild.id); if (q) { q.player.unpause(); await interaction.reply('▶️ Devam ediyor.'); } }
    if (commandName === 'atla') { const q = queue.get(guild.id); if (q) { q.player.stop(); await interaction.reply('⏭️ Atlandı.'); } }
    if (commandName === 'ses') { const q = queue.get(guild.id); const vol = interaction.options.getInteger('seviye'); if (q) { q.volume = vol; await interaction.reply(`🔊 Ses: %${vol}`); } }
    if (commandName === 'git') { const q = queue.get(guild.id); if (q) { q.connection.destroy(); queue.delete(guild.id); } await interaction.reply('👋 Çıkış yapıldı.'); }
});

process.on('unhandledRejection', e => console.error('Hata:', e));
client.login(process.env.DISCORD_TOKEN);
