// V5.0 - SON SINYAL COZUMU
const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    NoSubscriberBehavior,
    getVoiceConnection,
    entersState
} = require('@discordjs/voice');
const play = require('play-dl');
const ytdl = require('yt-dlp-exec');
const ytdlCore = require('@distube/ytdl-core');
const ytdlNormal = require('ytdl-core');

// ─── Bot Yapılandırması ───
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

/**
 * SES KANALINA BAĞLANMA (AĞ HATA AYIKLAMA SİSTEMİ)
 * Signalling Loop hatasını kırmak için tasarlanmıştır.
 */
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;
    let connection = getVoiceConnection(guildId, client.user.id);

    if (connection) {
        if (connection.joinConfig.channelId !== channel.id) {
            console.log(`🔄 [KANAL GEÇİŞİ] Eski bağlantı yok ediliyor: #${channel.name}`);
            connection.destroy();
        } else {
            return connection;
        }
    }

    console.log(`🔌 [BAĞLANTI BAŞLATILDI] #${channel.name} kanalına giriş deneniyor...`);
    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
        debug: true // Discord kütüphanesinin arka plan loglarını açar
    });

    // GELİŞMİŞ DEBUG LOGLARI: Tam olarak nerede takıldığını söyler
    connection.on('debug', (message) => {
        if (message.includes('Signalling') || message.includes('Connecting')) {
            console.log(`🔍 [AĞ DETAYI] ${message}`);
        }
    });

    // DÖNGÜ KIRICI: 20 saniye boyunca READY olmazsa sıfırla
    const loopKiller = setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            console.log('⚠️ [DÖNGÜ KIRICI] Bağlantı "READY" olamadı. Sıfırlanıp 2 saniye sonra tekrar denenecek...');
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            setTimeout(() => manageVoiceConnection(channel), 2000);
        }
    }, 20000);

    connection.on('stateChange', (oldState, newState) => {
        console.log(`🌐 [DURUM] ${oldState.status} -> ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Ready) {
            clearTimeout(loopKiller);
            console.log('✅ [BAĞLANTI TAMAM] Bot şu an ses sunucusuna %100 bağlandı!');
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log('⚠️ [KOPTU] Bağlantı koptu, yeniden deneniyor...');
        }
    });

    return connection;
}

/**
 * ŞARKI OYNATMA (STABIL STREAM)
 */
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) return finalizeQueue(guildId);

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Stream Hazırlanıyor: ${song.title}`);

        const stream = await ytdlCore(song.url, {
            filter: 'audioonly', quality: 'highestaudio',
            highWaterMark: 1 << 25, dlChunkSize: 0
        });

        const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
        resource.volume.setVolume(serverQueue.volume / 100);

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`✅ [PLAYING] ${song.title}`);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

        serverQueue.player.on('error', e => {
            console.error('❌ Player Hatası:', e.message);
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

    } catch (err) {
        console.error('❌ Akış Hatası:', err.message);
        // Fallback: yt-dlp
        const output = ytdl.exec(song.url, { output: '-', format: 'bestaudio/best', addHeader: ['referer:https://www.youtube.com/'] });
        const res = createAudioResource(output.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
        res.volume.setVolume(serverQueue.volume / 100);
        serverQueue.player.play(res);
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
            if (c && c.isVoiceBased()) manageVoiceConnection(c);
        } catch (e) { console.error(e); }
    } else {
        if (serverQueue && serverQueue.connection) serverQueue.connection.destroy();
    }
    queue.delete(guildId);
}

// ─── Slash Komutları ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Sese çağırır'),
    new SlashCommandBuilder().setName('cal').setDescription('Müzik çalar').addStringOption(o => o.setName('link').setDescription('Youtube Link').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Duraklatır'),
    new SlashCommandBuilder().setName('devam').setDescription('Devam ettirir'),
    new SlashCommandBuilder().setName('atla').setDescription('Sıradaki'),
    new SlashCommandBuilder().setName('git').setDescription('Ayrılır'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses ayarı').addIntegerOption(o => o.setName('seviye').setDescription('1-100').setRequired(true)),
].map(c => c.toJSON());

// ─── Bot Events ───
client.once('clientReady', async () => {
    console.log(`🚀 [BOT AKTİF] ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }], status: 'online' });

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });

    // 8 saniye gecikmeli sese bağlanma (Gateway için en güvenlisi)
    setTimeout(async () => {
        const wCID = process.env.WAIT_CHANNEL_ID;
        const wGID = process.env.WAIT_GUILD_ID;
        if (wCID && wGID) {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) manageVoiceConnection(c);
            } catch (e) { console.error('İlk giriş hatası:', e); }
        }
    }, 8000);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = interaction;

    if (commandName === 'cal') {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) return interaction.reply({ content: '❌ Sese girmelisin!', ephemeral: true });

        const url = interaction.options.getString('link');
        if (!play.yt_validate(url)) return interaction.reply({ content: '❌ Geçersiz link!', ephemeral: true });

        await interaction.deferReply();

        try {
            console.log('📡 Bilgiler alınıyor...');
            let info;
            try { info = await ytdlCore.getBasicInfo(url); } catch { info = await ytdlNormal.getBasicInfo(url); }

            const song = { title: info.videoDetails.title, url: url, duration: new Date(info.videoDetails.lengthSeconds * 1000).toISOString().substr(11, 8).replace(/^00:/, '') };

            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                const connection = manageVoiceConnection(voiceChannel);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => { if (n.status === AudioPlayerStatus.AutoPaused) player.unpause(); });

                sQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, sQueue);

                await interaction.editReply(`🎵 Çalınıyor: **${song.title}**`);

                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
                    playSong(guild.id, interaction);
                } catch {
                    console.log('⚠️ Bağlantı hala tam hazır değil, yine de stream deneniyor...');
                    playSong(guild.id, interaction);
                }
            } else {
                sQueue.songs.push(song);
                await interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
            }
        } catch (e) {
            console.error('❌ Hata:', e.message);
            await interaction.editReply(`❌ Şarkı bilgisi alınamadı. YouTube botu engellemiş olabilir.`);
        }
    }

    if (commandName === 'dur') {
        const q = queue.get(guild.id);
        if (q) { q.player.pause(); await interaction.reply('⏸️ Durduruldu.'); }
    }

    if (commandName === 'devam') {
        const q = queue.get(guild.id);
        if (q) { q.player.unpause(); await interaction.reply('▶️ Devam ediyor.'); }
    }

    if (commandName === 'atla') {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); await interaction.reply('⏭️ Atlandı.'); }
    }

    if (commandName === 'git') {
        const q = queue.get(guild.id);
        if (q) { q.songs = []; q.player.stop(); q.connection.destroy(); queue.delete(guild.id); }
        await interaction.reply('👋 Çıktım.');
        setTimeout(() => finalizeQueue(guild.id), 2000);
    }

    if (commandName === 'ses') {
        const q = queue.get(guild.id);
        const voltip = interaction.options.getInteger('seviye');
        if (q) { q.volume = voltip; if (q.resource && q.resource.volume) q.resource.volume.setVolume(voltip / 100); await interaction.reply(`🔊 Ses: %${voltip}`); }
    }
});

process.on('unhandledRejection', e => console.error('Hata:', e));
client.login(process.env.DISCORD_TOKEN);
