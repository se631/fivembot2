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
const queue = new Map(); // Her sunucu için ayrı kuyruk verisi

/**
 * SES KANALINA BAĞLANMA (GELİŞMİŞ)
 * Signalling/Connecting döngülerini kırmak için bağlantıyı yönetir.
 */
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;

    // Mevcut bir bağlantı olup olmadığını kontrol et
    let connection = getVoiceConnection(guildId, client.user.id);

    if (connection) {
        // Eğer zaten bağlıysa ve kanal farklıysa kanalı değiştir
        if (connection.joinConfig.channelId !== channel.id) {
            console.log(`🔄 Kanal değiştiriliyor: #${channel.name}`);
            connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guildId,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: true,
                selfMute: false,
                group: client.user.id
            });
        }
    } else {
        // Yeni bağlantı oluştur
        console.log(`🔌 Yeni bağlantı kuruluyor: #${channel.name}`);
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guildId,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
            group: client.user.id
        });
    }

    // Durum değişikliklerini ve hazır olma durumunu takip et
    connection.removeAllListeners('stateChange'); // Eski dinleyicileri temizle
    connection.on('stateChange', (oldState, newState) => {
        console.log(`🌐 [BAĞLANTI] ${oldState.status} -> ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Ready) {
            console.log('✅ [HAZIR] Ses sunucusuyla tam bağlantı kuruldu.');
        }

        // Eğer bağlantı koptuysa veya yok edildiyse kuyruğu kontrol et
        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log('⚠️ [UYARI] Bağlantı koptu, kurtarılmaya çalışılıyor...');
            try {
                Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                ]).catch(() => {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                        console.log('❌ [HATA] Bağlantı kurtarılamadı ve yok edildi.');
                    }
                });
            } catch (e) {
                console.error('Bağlantı fail-safe hatası:', e);
            }
        }
    });

    return connection;
}

/**
 * MÜZİK ÇALMA MANTIĞI
 */
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        console.log('🎵 Kuyruk bitti.');
        return finalizeQueue(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Yayına hazırlanıyor: ${song.title}`);

        // yt-dlp ile en güvenli stream (Agent taklidi yaparak)
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

        if (!output.stdout) throw new Error('Yayın çıktısı alınamadı.');

        const resource = createAudioResource(output.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`✅ [OYNATILIYOR] ${song.title}`);

        // Player olayları
        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            console.log('⏭️ Şarkı bitti, sıradakine geçiliyor...');
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

        serverQueue.player.once('error', error => {
            console.error('❌ Player hatası:', error.message);
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

    } catch (err) {
        console.error('❌ Akış hatası:', err.message);
        if (serverQueue.textChannel) {
            serverQueue.textChannel.send(`⚠️ Şarkı başlatılamadı: ${err.message}`).catch(() => { });
        }
        serverQueue.songs.shift();
        playSong(guildId, interaction);
    }
}

/**
 * BEKLEME KANALINA DÖNÜŞ VEYA TEMİZLİK
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
        } catch (e) {
            console.error('Bekleme kanalına dönüş hatası:', e);
        }
    } else {
        if (serverQueue && serverQueue.connection) {
            serverQueue.connection.destroy();
        }
    }
    queue.delete(guildId);
}

// ───Slash Komut Tanımları ───
const commands = [
    new SlashBuilder('gel', 'Botu sese çağırır'),
    new SlashBuilder('cal', 'YouTube linkini çalar', true),
    new SlashBuilder('dur', 'Müziği duraklatır'),
    new SlashBuilder('devam', 'Müziği devam ettirir'),
    new SlashBuilder('atla', 'Sıradaki şarkıya geçer'),
    new SlashBuilder('kuyruk', 'Listeyi gösterir'),
    new SlashBuilder('ses', 'Sesi ayarlar (1-100)', false, true),
    new SlashBuilder('git', 'Kanaldan çıkar'),
];

function SlashBuilder(name, desc, hasLink = false, hasLevel = false) {
    const b = new SlashCommandBuilder().setName(name).setDescription(desc);
    if (hasLink) b.addStringOption(o => o.setName('link').setDescription('YouTube Linki').setRequired(true));
    if (hasLevel) b.addIntegerOption(o => o.setName('seviye').setDescription('Ses Seviyesi').setRequired(true).setMinValue(1).setMaxValue(100));
    return b.toJSON();
}

// ─── Bot Olayları ───
client.once('clientReady', async () => {
    console.log(`🚀 [AKTİF] ${client.user.tag}`);

    // Status Ayarı
    client.user.setPresence({
        activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }],
        status: 'online'
    });

    // Slash Komut Kaydı
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Komutlar kaydediliyor...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Komutlar hazır.');
    } catch (e) { console.error('Komut kayıt hatası:', e); }

    // Başlangıçta bekleme kanalına gir
    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    if (wCID && wGID) {
        setTimeout(async () => {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) manageVoiceConnection(c);
            } catch (e) { console.error('Başlangıç sese bağlanma hatası:', e); }
        }, 5000); // 5 saniye bekleme (Gateway stabilizasyonu için)
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = interaction;

    if (commandName === 'cal') {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) return interaction.reply({ content: '❌ Önce bir ses kanalına girmelisin!', ephemeral: true });

        const url = interaction.options.getString('link');
        if (!play.yt_validate(url)) return interaction.reply({ content: '❌ Geçersiz YouTube linki!', ephemeral: true });

        await interaction.deferReply();

        try {
            console.log('📡 Şarkı bilgisi alınıyor (Fallback sistemi aktif)...');
            let info;
            try {
                info = await ytdlCore.getBasicInfo(url);
            } catch (e1) {
                console.log('⚠️ ytdl-core başarısız, ytdl-normal deneniyor...');
                info = await ytdlNormal.getBasicInfo(url);
            }

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
                    console.log(`🎵 [PLAYER] ${o.status} -> ${n.status}`);
                    if (n.status === AudioPlayerStatus.AutoPaused) {
                        console.log('⚠️ Autopaused kilitlendi, zorla devam ettiriliyor...');
                        player.unpause();
                    }
                });

                serverQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, serverQueue);

                await interaction.editReply(`🎵 Çalmaya hazırlanıyor: **${song.title}**`);

                // Bağlantının hazır olmasını güvenli bir şekilde bekle
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
                    playSong(guild.id, interaction);
                } catch (e) {
                    console.log('⚠️ Bağlantı hazır olma süresi aşıldı, yine de çalma deneniyor...');
                    playSong(guild.id, interaction);
                }
            } else {
                serverQueue.songs.push(song);
                await interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}**`);
            }
        } catch (e) {
            console.error('❌ CAL Hatası:', e.message);
            await interaction.editReply(`❌ Şarkı bilgisi alınamadı. (YouTube kısıtlaması).`);
        }
    }

    if (commandName === 'dur') {
        const q = queue.get(guild.id);
        if (q) { q.player.pause(); await interaction.reply('⏸️ Durduruldu.'); }
        else await interaction.reply({ content: '❌ Çalan bir şey yok.', ephemeral: true });
    }

    if (commandName === 'devam') {
        const q = queue.get(guild.id);
        if (q) { q.player.unpause(); await interaction.reply('▶️ Devam ediyor.'); }
        else await interaction.reply({ content: '❌ Çalan bir şey yok.', ephemeral: true });
    }

    if (commandName === 'atla') {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); await interaction.reply('⏭️ Atlandı.'); }
        else await interaction.reply({ content: '❌ Atlanacak bir şey yok.', ephemeral: true });
    }

    if (commandName === 'git') {
        const q = queue.get(guild.id);
        if (q) {
            q.songs = [];
            q.player.stop();
            q.connection.destroy();
            queue.delete(guild.id);
        }
        await interaction.reply('👋 Çıkış yapıldı.');
        setTimeout(() => finalizeQueue(guild.id), 2000);
    }
});

// ─── Fail-Safe ───
process.on('unhandledRejection', e => console.error('❌ Yakalanmamış Hata:', e));
client.login(process.env.DISCORD_TOKEN);
