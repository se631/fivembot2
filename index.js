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
 * SES KANALINA BAĞLANMA (DÖNGÜ KIRICI SİSTEM)
 * Railway üzerindeki Signalling Loop hatasını aşmak için tasarlanmıştır.
 */
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;
    let connection = getVoiceConnection(guildId, client.user.id);

    // Eğer zaten bağlıysa ve kanal farklıysa eskiyi tamamen temizle
    if (connection) {
        if (connection.joinConfig.channelId !== channel.id) {
            console.log(`🔄 [KANAL DEĞİŞİMİ] Eski bağlantı temizleniyor: #${channel.name}`);
            connection.destroy();
        } else {
            return connection;
        }
    }

    console.log(`🔌 [BAĞLANILIYOR] #${channel.name} kanalına giriş yapılıyor...`);
    connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
    });

    // DÖNGÜ KIRICI: Eğer 15 saniye içinde hazıra geçmezse bağlantıyı tazele
    const loopTimeout = setTimeout(() => {
        if (connection.state.status === VoiceConnectionStatus.Signalling ||
            connection.state.status === VoiceConnectionStatus.Connecting) {
            console.log('⚠️ [DÖNGÜ KIRICI] Sinyal aşamasında takıldı. Bağlantı sıfırlanıyor...');
            connection.destroy();
            setTimeout(() => manageVoiceConnection(channel), 1000); // 1 saniye sonra tekrar dene
        }
    }, 15000);

    connection.on('stateChange', (oldState, newState) => {
        console.log(`🌐 [DURUM] ${oldState.status} -> ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Ready) {
            clearTimeout(loopTimeout);
            console.log('✅ [HAZIR] Ses aktarımı için el sıkışma tamamlandı!');
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log('⚠️ [AYRILDI] Bağlantı kesildi.');
        }
    });

    return connection;
}

/**
 * ŞARKI OYNATMA (EN KARARLI YÖNTEM)
 */
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        console.log('🎵 Liste tamamlandı.');
        return finalizeQueue(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Stream Hazırlanıyor: ${song.title}`);

        // @distube/ytdl-core kullanarak stream alalım (Railway için daha stabil)
        const stream = await ytdlCore(song.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25, // 32MB Buffer
            dlChunkSize: 0
        });

        const resource = createAudioResource(stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);

        // Önce Player'ı başlat, sonra bağlantıya bağla
        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`✅ [OYNIYOR] ${song.title}`);

        // Olay dinleyicileri
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            console.log('⏭️ Şarkı bitti.');
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

        serverQueue.player.once('error', error => {
            console.error('❌ Player Hatası:', error.message);
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

    } catch (err) {
        console.error('❌ Akış Hatası:', err.message);
        // Fallback: yt-dlp ile tekrar dene
        try {
            console.log('⚠️ Ytdl-core başarısız, yt-dlp ile son deneme yapılıyor...');
            const output = ytdl.exec(song.url, {
                output: '-', format: 'bestaudio/best',
                addHeader: ['referer:https://www.youtube.com/']
            }, { stdio: ['ignore', 'pipe', 'ignore'] });

            const fallbackRes = createAudioResource(output.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
            fallbackRes.volume.setVolume(serverQueue.volume / 100);
            serverQueue.player.play(fallbackRes);
        } catch (e) {
            if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ Şarkı çalınamadı: ${err.message}`).catch(() => { });
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        }
    }
}

/**
 * BEKLEME KANALINA DÖNÜŞ
 */
async function finalizeQueue(guildId) {
    const serverQueue = queue.get(guildId);
    const waitCID = process.env.WAIT_CHANNEL_ID;
    const waitGID = process.env.WAIT_GUILD_ID;

    if (waitCID && waitGID && guildId === waitGID) {
        try {
            const guild = await client.guilds.fetch(waitGID);
            const channel = await guild.channels.fetch(waitCID);
            if (channel && channel.isVoiceBased()) {
                console.log('🏠 Bekleme kanalına dönülüyor...');
                manageVoiceConnection(channel);
            }
        } catch (e) { console.error('Geri dönüş hatası:', e); }
    } else {
        if (serverQueue && serverQueue.connection) serverQueue.connection.destroy();
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
    new SlashCommandBuilder().setName('ses').setDescription('Ses (1-100)').addIntegerOption(o => o.setName('seviye').setDescription('Seviye').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('git').setDescription('Çıkış yapar'),
].map(cmd => cmd.toJSON());

// ─── Bot Events ───
client.once('clientReady', async () => {
    console.log(`🚀 [AKTİF] ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }], status: 'online' });

    // Komutları kaydet
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try { await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands }); console.log('✅ Komutlar hazır.'); } catch (e) { console.error(e); }

    // Başlangıç bekleme kanalına gir (5 saniye sonra)
    setTimeout(async () => {
        const wCID = process.env.WAIT_CHANNEL_ID;
        const wGID = process.env.WAIT_GUILD_ID;
        if (wCID && wGID) {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) manageVoiceConnection(c);
            } catch (e) { console.error('Başlangıç hatası:', e); }
        }
    }, 5000);
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
            console.log('📡 Şarkı bilgisi alınıyor...');
            let info;
            try { info = await ytdlCore.getBasicInfo(url); }
            catch { info = await ytdlNormal.getBasicInfo(url); }

            const song = {
                title: info.videoDetails.title,
                url: url,
                duration: new Date(info.videoDetails.lengthSeconds * 1000).toISOString().substr(11, 8).replace(/^00:/, '')
            };

            let serverQueue = queue.get(guild.id);
            if (!serverQueue) {
                const connection = manageVoiceConnection(voiceChannel);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => {
                    if (n.status === AudioPlayerStatus.AutoPaused) player.unpause();
                });

                serverQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, serverQueue);

                await interaction.editReply(`🎵 Çalınıyor: **${song.title}**`);

                // Bağlantının hazır olmasını esnek bekle
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
                    playSong(guild.id, interaction);
                } catch {
                    console.log('⚠️ Hazır olması beklemeden çalma deneniyor...');
                    playSong(guild.id, interaction);
                }
            } else {
                serverQueue.songs.push(song);
                await interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
            }
        } catch (e) {
            console.error('❌ Hata:', e.message);
            await interaction.editReply(`❌ Şarkı bilgisi alınamadı (YouTube Engeli).`);
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
        await interaction.reply('👋 Çıkış yapıldı.');
        setTimeout(() => finalizeQueue(guild.id), 2000);
    }

    if (commandName === 'ses') {
        const q = queue.get(guild.id);
        const voltip = interaction.options.getInteger('seviye');
        if (q) {
            q.volume = voltip;
            if (q.resource && q.resource.volume) q.resource.volume.setVolume(voltip / 100);
            await interaction.reply(`🔊 Ses: %${voltip}`);
        }
    }
});

process.on('unhandledRejection', e => console.error(e));
client.login(process.env.DISCORD_TOKEN);
