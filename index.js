const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    NoSubscriberBehavior,
    getVoiceConnection
} = require('@discordjs/voice');
const play = require('play-dl');
const ytdl = require('yt-dlp-exec');
const ytdlCore = require('@distube/ytdl-core');
const ytdlNormal = require('ytdl-core');

// ─── Bot Client ───
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─── Global Değişkenler ───
const queue = new Map(); // guildId -> queueData

// ─── Yardımcı Fonksiyon: Ses Kanalına Katılma ───
function connectToVoice(channel) {
    return joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,  // Kulaklık kapalı
        selfMute: false, // Mikrofon açık
        group: client.user.id
    });
}

// ─── Slash Komutları ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Botu ses kanalına çağırır'),
    new SlashCommandBuilder().setName('cal').setDescription('YouTube linkini çalar')
        .addStringOption(opt => opt.setName('link').setDescription('YouTube linki').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Müziği duraklatır'),
    new SlashCommandBuilder().setName('devam').setDescription('Müziği devam ettirir'),
    new SlashCommandBuilder().setName('atla').setDescription('Sıradaki şarkıya geçer'),
    new SlashCommandBuilder().setName('kuyruk').setDescription('Şarkı kuyruğunu gösterir'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses seviyesi (1-100)')
        .addIntegerOption(opt => opt.setName('seviye').setDescription('Seviye').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('git').setDescription('Botu kanaldan çıkarır'),
].map(cmd => cmd.toJSON());

// ─── Komut Kayıt ───
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash komutları kaydedildi.');
    } catch (err) { console.error('❌ Kayıt hatası:', err); }
}

// ─── Şarkı Çalma ───
async function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        // Müzik bitti, bekleme kanalına dönme kontrolü
        return returnToWaitChannel(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Oynatılıyor: ${song.title}`);

        const output = ytdl.exec(song.url, {
            output: '-',
            format: 'bestaudio/best',
            limitRate: '1M',
            noCheckCertificates: true,
            addHeader: [
                'referer:https://www.youtube.com/',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        }, { stdio: ['ignore', 'pipe', 'ignore'] });

        if (!output.stdout) throw new Error('Stream alınamadı');

        const resource = createAudioResource(output.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);
        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

    } catch (err) {
        console.error('❌ Çalma hatası:', err.message);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`❌ Hata: ${err.message}`);
        serverQueue.songs.shift();
        playSong(guildId);
    }
}

async function returnToWaitChannel(guildId) {
    const waitChannelId = process.env.WAIT_CHANNEL_ID;
    const waitGuildId = process.env.WAIT_GUILD_ID;

    if (waitChannelId && waitGuildId && guildId === waitGuildId) {
        try {
            const guild = await client.guilds.fetch(waitGuildId);
            const channel = await guild.channels.fetch(waitChannelId);
            if (channel && channel.isVoiceBased()) {
                connectToVoice(channel);
                console.log('🏠 Bekleme kanalına dönüldü.');
            }
        } catch (e) { console.error('❌ Dönüş hatası:', e); }
    } else {
        const connection = getVoiceConnection(guildId, client.user.id);
        if (connection) connection.destroy();
    }
    queue.delete(guildId);
}

// ─── Bot Events ───
client.once('clientReady', async () => {
    console.log(`✅ ${client.user.tag} Aktif!`);
    client.user.setPresence({
        activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }],
        status: 'online'
    });

    // İlk girişte bekleme kanalına katıl
    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    if (wCID && wGID) {
        setTimeout(async () => {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) {
                    const conn = connectToVoice(c);
                    conn.on('stateChange', (o, n) => console.log(`🌐 [Bağlantı] ${o.status} -> ${n.status}`));
                    console.log(`🔈 Bekleme kanalı: #${c.name}`);
                }
            } catch (e) { console.error('❌ İlk giriş hatası:', e); }
        }, 3000);
    }
    await registerCommands();
});

client.on('interactionCreate', async (int) => {
    if (!int.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = int;

    if (commandName === 'cal') {
        const vChan = member.voice.channel;
        if (!vChan) return int.reply({ content: '❌ Sese gir!', ephemeral: true });

        const url = int.options.getString('link');
        if (!play.yt_validate(url)) return int.reply({ content: '❌ Geçersiz link!', ephemeral: true });

        await int.deferReply();

        try {
            console.log('📡 Veriler alınıyor...');
            const meta = await ytdl(url, { dumpSingleJson: true, noCheckCertificates: true, addHeader: ['referer:https://www.youtube.com/'] });
            const song = { title: meta.title, url: url, duration: meta.duration_string || '00:00' };

            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                const connection = connectToVoice(vChan);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => {
                    console.log(`🎵 [Player] ${o.status} -> ${n.status}`);
                    if (n.status === AudioPlayerStatus.Idle) {
                        sQueue.songs.shift();
                        playSong(guild.id);
                    }
                    if (n.status === AudioPlayerStatus.AutoPaused) {
                        console.log('⚠️ AutoPaused algılandı, unpause yapılıyor...');
                        player.unpause();
                    }
                });

                sQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, sQueue);

                await int.editReply(`🎵 Çalınıyor: **${song.title}**`);
                playSong(guild.id);
            } else {
                sQueue.songs.push(song);
                await int.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
            }
        } catch (e) {
            console.error('❌ Cal hatası:', e);
            await int.editReply('❌ Hata oluştu, tekrar dene.');
        }
    }

    if (commandName === 'dur') {
        const q = queue.get(guild.id);
        if (q) { q.player.pause(); await int.reply('⏸️ Durduruldu.'); }
        else await int.reply({ content: '❌ Çalan bir şey yok.', ephemeral: true });
    }

    if (commandName === 'devam') {
        const q = queue.get(guild.id);
        if (q) { q.player.unpause(); await int.reply('▶️ Devam ediyor.'); }
        else await int.reply({ content: '❌ Çalan bir şey yok.', ephemeral: true });
    }

    if (commandName === 'atla') {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); await int.reply('⏭️ Sıradakine geçildi.'); }
        else await int.reply({ content: '❌ Atlanacak bir şey yok.', ephemeral: true });
    }

    if (commandName === 'git') {
        const q = queue.get(guild.id);
        if (q) { q.songs = []; q.player.stop(); q.connection.destroy(); queue.delete(guild.id); }
        const conn = getVoiceConnection(guild.id, client.user.id);
        if (conn) conn.destroy();
        await int.reply('👋 Görüşürüz!');
        setTimeout(() => returnToWaitChannel(guild.id), 2000);
    }
});

process.on('unhandledRejection', e => console.error('❌ Hata:', e));
client.login(process.env.DISCORD_TOKEN);
