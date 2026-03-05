const { Client, GatewayIntentBits, ActivityType, REST, Routes } = require('discord.js');
const {
    joinVoiceChannel, createAudioPlayer, createAudioResource,
    AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
    getVoiceConnection, entersState
} = require('@discordjs/voice');
const play = require('play-dl');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const queue = new Map();

// ─── SES BAĞLANTISI (AFK MODU) ───
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;
    let connection = getVoiceConnection(guildId);

    if (connection && connection.joinConfig.channelId === channel.id) return connection;
    if (connection) connection.destroy();

    console.log(`🔌 [BAĞLANTI] #${channel.name} kanalına giriliyor...`);
    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true, // Kulaklık kapalı (Kırmızı işaret)
        selfMute: false // Mikrofon açık
    });

    const resetTimer = setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            console.log('⚠️ [BAĞLANTI] Yenileniyor...');
            connection.destroy();
            setTimeout(() => manageVoiceConnection(channel), 2000);
        }
    }, 15000);

    connection.on('stateChange', (o, n) => {
        if (n.status === VoiceConnectionStatus.Ready) {
            clearTimeout(resetTimer);
            console.log('✅ [SES] Aktif.');
        }
    });

    return connection;
}

// ─── MÜZİK MOTORU ───
async function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) return finalizeQueue(guildId);

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Oynatılıyor: ${song.title}`);
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true, quality: 2 });
        const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
        resource.volume.setVolume(serverQueue.volume / 100);
        serverQueue.resource = resource;

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);
    } catch (err) {
        serverQueue.songs.shift();
        playSong(guildId);
    }
}

async function finalizeQueue(guildId) {
    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    const serverQueue = queue.get(guildId);

    if (wCID && wGID && guildId === wGID) {
        try {
            const g = await client.guilds.fetch(wGID);
            const c = await g.channels.fetch(wCID);
            if (c) manageVoiceConnection(c);
        } catch (e) { }
    } else if (serverQueue && serverQueue.connection) {
        serverQueue.connection.destroy();
    }
    queue.delete(guildId);
}

// ─── KOMUTLAR (HATA VERMEYEN HAM FORM) ───
const commands = [
    { name: 'gel', description: 'Botu sese çağırır.' },
    { name: 'cal', description: 'Müzik çalar.', options: [{ name: 'link', description: 'YouTube Linki', type: 3, required: true }] },
    { name: 'dur', description: 'Müziği durdurur.' },
    { name: 'devam', description: 'Müziği devam ettirir.' },
    { name: 'atla', description: 'Şarkıyı atlar.' },
    { name: 'git', description: 'Bekleme kanalına döner.' },
    { name: 'ses', description: 'Ses ayarı.', options: [{ name: 'seviye', description: '1-100 arası', type: 4, required: true }] },
    { name: 'kuyruk', description: 'Listeyi gösterir.' }
];

// ─── BOT EVENTLERİ ───
client.once('ready', async () => {
    console.log(`🚀 [BOT AKTİF] ${client.user.tag}`);

    // YAYIN DURUMU
    client.user.setPresence({
        activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }],
        status: 'online'
    });

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Komutlar tanımlandı.');
    } catch (e) { console.error('Kayıt Hatası:', e); }

    // BAŞLANGIÇTA ODAYA GİRİŞ
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
    }, 5000);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member } = interaction;

    if (commandName === 'cal') {
        const vChannel = member.voice.channel;
        if (!vChannel) return interaction.reply({ content: '❌ Sese girin!', ephemeral: true });

        await interaction.deferReply();
        const url = interaction.options.getString('link');

        try {
            const songInfo = await play.video_info(url);
            const song = { title: songInfo.video_details.title, url: url };

            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                const connection = manageVoiceConnection(vChannel);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => {
                    if (n.status === AudioPlayerStatus.Idle) {
                        const q = queue.get(guild.id);
                        if (q) { q.songs.shift(); playSong(guild.id); }
                    }
                    if (n.status === AudioPlayerStatus.AutoPaused) player.unpause();
                });

                sQueue = { connection, player, songs: [song], volume: 50, resource: null };
                queue.set(guild.id, sQueue);
                await interaction.editReply(`🎵 Çalınıyor: **${song.title}**`);

                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 10000);
                    playSong(guild.id);
                } catch { playSong(guild.id); }
            } else {
                sQueue.songs.push(song);
                await interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
                if (sQueue.player.state.status === AudioPlayerStatus.Idle) playSong(guild.id);
            }
        } catch (e) { await interaction.editReply(`❌ Hata: ${e.message}`); }
    }

    const q = queue.get(guild.id);
    if (commandName === 'dur' && q) { q.player.pause(); await interaction.reply('⏸️ Durduruldu.'); }
    if (commandName === 'devam' && q) { q.player.unpause(); await interaction.reply('▶️ Devam ediyor.'); }
    if (commandName === 'atla' && q) { q.player.stop(); await interaction.reply('⏭️ Atlandı.'); }
    if (commandName === 'git') { await interaction.reply('👋 Bekleme moduna geçiliyor.'); await finalizeQueue(guild.id); }
    if (commandName === 'ses' && q) {
        const v = interaction.options.getInteger('seviye');
        if (v < 1 || v > 100) return interaction.reply('❌ 1-100 arası!');
        q.volume = v;
        if (q.resource) q.resource.volume.setVolume(v / 100);
        await interaction.reply(`🔊 Ses: %${v}`);
    }
    if (commandName === 'kuyruk' && q) {
        const list = q.songs.map((s, i) => `${i === 0 ? '🎵' : i + '.'} ${s.title}`).slice(0, 10).join('\n');
        await interaction.reply(`📋 **Kuyruk:**\n${list}`);
    }
});

process.on('unhandledRejection', e => { });
client.login(process.env.DISCORD_TOKEN);
