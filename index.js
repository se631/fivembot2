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
const queue = new Map();

// ─── Yardımcı Fonksiyonlar ───

// SES KANALINA KATILMA
function connectToVoice(channel) {
    return joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
        group: client.user.id
    });
}

// ─── Şarkı Çalma ───
async function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        return returnToWaitChannel(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Stream başlatılıyor: ${song.title}`);

        // yt-dlp ile en dayanıklı stream
        const output = ytdl.exec(song.url, {
            output: '-',
            format: 'bestaudio/best',
            limitRate: '1M',
            noCheckCertificates: true,
            addHeader: [
                'referer:https://www.youtube.com/',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ]
        }, { stdio: ['ignore', 'pipe', 'ignore'] });

        if (!output.stdout) throw new Error('Yayın bağlantısı kurulamadı.');

        const resource = createAudioResource(output.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);
        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`🎵 Oynatılıyor: ${song.title}`);

    } catch (err) {
        console.error('❌ Oynatma hatası:', err.message);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ Şarkı çalınamadı (YouTube kısıtlaması). Sıradakine geçiliyor...`).catch(() => { });
        serverQueue.songs.shift();
        playSong(guildId);
    }
}

async function returnToWaitChannel(guildId) {
    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    if (wCID && wGID && guildId === wGID) {
        try {
            const g = await client.guilds.fetch(wGID);
            const c = await g.channels.fetch(wCID);
            if (c && c.isVoiceBased()) connectToVoice(c);
        } catch (e) { console.error('Geri dönüş hatası:', e); }
    } else {
        const conn = getVoiceConnection(guildId, client.user.id);
        if (conn) conn.destroy();
    }
    queue.delete(guildId);
}

// ─── Slash Komutları ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Botu sese çağırır'),
    new SlashCommandBuilder().setName('cal').setDescription('Müzik çalar').addStringOption(o => o.setName('link').setDescription('YouTube Linki').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Durdurur'),
    new SlashCommandBuilder().setName('devam').setDescription('Devam ettirir'),
    new SlashCommandBuilder().setName('atla').setDescription('Şarkıyı atlar'),
    new SlashCommandBuilder().setName('kuyruk').setDescription('Listeyi gösterir'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses seviyesi (1-100)').addIntegerOption(o => o.setName('seviye').setDescription('Ses').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('git').setDescription('Kanaldan çıkar'),
].map(cmd => cmd.toJSON());

// ─── Başlangıç ───
client.once('clientReady', async () => {
    console.log(`✅ ${client.user.tag} Hazır!`);
    client.user.setPresence({ activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }], status: 'online' });

    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    if (wCID && wGID) {
        setTimeout(async () => {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) {
                    const conn = connectToVoice(c);
                    conn.on('stateChange', (o, n) => {
                        console.log(`🌐 [DURUM] ${o.status} -> ${n.status}`);
                        if (n.status === VoiceConnectionStatus.Ready) console.log('✅ [BAĞLANTI TAMAM] Ses akışı hazır.');
                    });
                }
            } catch (e) { console.error('Bağlantı hatası:', e); }
        }, 2000);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Komutlar kaydedildi.');
});

client.on('interactionCreate', async (int) => {
    if (!int.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = int;

    if (commandName === 'cal') {
        const vChan = member.voice.channel;
        if (!vChan) return int.reply({ content: '❌ Sese girin!', ephemeral: true });

        const url = int.options.getString('link');
        if (!play.yt_validate(url)) return int.reply({ content: '❌ Geçersiz YouTube linki!', ephemeral: true });

        await int.deferReply();

        try {
            console.log('📡 Şarkı bilgisi alınıyor...');

            // 410 ve Bot uyarılarını aşmak için ytdl-core (distube) kullanıyoruz
            let info;
            try {
                info = await ytdlCore.getBasicInfo(url);
            } catch (err) {
                console.log('⚠️ distube hatası, normal ytdl deneniyor...');
                info = await ytdlNormal.getBasicInfo(url);
            }

            const song = {
                title: info.videoDetails.title,
                url: url,
                duration: new Date(info.videoDetails.lengthSeconds * 1000).toISOString().substr(11, 8).replace(/^00:/, '')
            };

            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                const connection = connectToVoice(vChan);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => {
                    if (n.status === AudioPlayerStatus.Idle) {
                        sQueue.songs.shift();
                        playSong(guild.id);
                    }
                    if (n.status === AudioPlayerStatus.AutoPaused) player.unpause();
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
            console.error('❌ HATA:', e.message);
            await int.editReply(`❌ Şarkı bilgisi alınamadı (YouTube Bot Engeli). Lütfen Railway Bölgesini (Region) değiştirip IP tazeleyin.`);
        }
    }

    if (commandName === 'atla') {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); await int.reply('⏭️ Şarkı atlandı.'); }
        else await int.reply({ content: '❌ Çalan bir şey yok.', ephemeral: true });
    }

    if (commandName === 'dur') {
        const q = queue.get(guild.id);
        if (q) { q.player.pause(); await int.reply('⏸️ Durduruldu.'); }
    }

    if (commandName === 'devam') {
        const q = queue.get(guild.id);
        if (q) { q.player.unpause(); await int.reply('▶️ Devam ediyor.'); }
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
