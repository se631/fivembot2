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

// ─── Yardımcı Fonksiyonlar ───

// SES KANALINA KATILMA (Gelişmiş & Çakışma Önleyici)
function connectToVoice(channel) {
    const existingConnection = getVoiceConnection(channel.guild.id);

    // Eğer zaten seste ise ve kanal aynıysa hiçbir şey yapma
    if (existingConnection && existingConnection.joinConfig.channelId === channel.id) {
        return existingConnection;
    }

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,  // Kulaklık kapalı (İstediğin gibi)
        selfMute: false, // Mikrofon açık
        debug: true
    });

    // Bağlantı durumlarını logla (Hata tespiti için kritik)
    connection.on('stateChange', (oldState, newState) => {
        console.log(`🌐 [BAĞLANTI] ${oldState.status} -> ${newState.status}`);

        if (newState.status === VoiceConnectionStatus.Ready) {
            console.log('✅ [BAĞLANTI BAŞARILI] Bot şu an ses sunucusuna tam bağlandı!');
        }

        if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log('⚠️ [BAĞLANTI KOPTU] Tekrar bağlanılıyor...');
            // Koparsa 5 saniye içinde tekrar bağlanmayı dene
            try {
                Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                ]).catch(() => {
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
                });
            } catch (e) { console.error('Failsafe reconnection error:', e); }
        }
    });

    return connection;
}

// ─── Şarkı Çalma ───
async function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        console.log('🎵 Kuyruk bitti, bekleme kanalına dönülüyor...');
        return returnToWaitChannel(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Stream hazırlanıyor (yt-dlp): ${song.title}`);

        // yt-dlp ile en güvenli stream çekme (browser simülasyonu ile)
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

        if (!output.stdout) throw new Error('YouTube stream verisi alınamadı.');

        const resource = createAudioResource(output.stdout, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);

        // Önce Player'ı hazırla
        serverQueue.player.play(resource);

        // Bağlantıya abone et
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`🎵 Oynatılıyor: ${song.title} (${song.duration})`);

    } catch (err) {
        console.error('❌ Çalma hatası:', err.message);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`❌ Şarkı çalınırken bir hata oluştu: ${err.message}`).catch(() => { });
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
                console.log('🏠 Kuyruk bitti, bekleme kanalına başarıyla dönüldü.');
            }
        } catch (e) { console.error('❌ Bekleme kanalına dönme hatası:', e); }
    }
    queue.delete(guildId);
}

// ─── Slash Komutları Tanımla ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Botu bulunduğun ses kanalına çağırır'),
    new SlashCommandBuilder().setName('cal').setDescription('YouTube linkini oynatır')
        .addStringOption(opt => opt.setName('link').setDescription('YouTube video linki').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Müziği geçici olarak durdurur'),
    new SlashCommandBuilder().setName('devam').setDescription('Durdurulan müziği devam ettirir'),
    new SlashCommandBuilder().setName('atla').setDescription('Sıradaki şarkıya geçer'),
    new SlashCommandBuilder().setName('kuyruk').setDescription('Şarkı listesini gösterir'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses seviyesini ayarlar (1-100)')
        .addIntegerOption(opt => opt.setName('seviye').setDescription('Ses seviyesi').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('git').setDescription('Botu kanaldan çıkarır ve kuyruğu temizler'),
].map(cmd => cmd.toJSON());

// ─── Komut Kayıt Fonksiyonu ───
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Slash komutları kaydediliyor...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash komutları başarıyla kaydedildi!');
    } catch (err) { console.error('❌ Komut kayıt hatası:', err); }
}

// ─── Bot Events ───
client.once('clientReady', async () => {
    console.log(`✅ ${client.user.tag} Aktif!`);

    client.user.setPresence({
        activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }],
        status: 'online'
    });

    // İlk açılışta 3 saniye bekleyip bekleme kanalına gir
    const wCID = process.env.WAIT_CHANNEL_ID;
    const wGID = process.env.WAIT_GUILD_ID;
    if (wCID && wGID) {
        setTimeout(async () => {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c && c.isVoiceBased()) {
                    connectToVoice(c);
                    console.log(`🔈 Başlangıç koruması: #${c.name} kanalına bağlanıldı.`);
                }
            } catch (e) { console.error('❌ Başlangıç bekleme kanalı hatası:', e); }
        }, 3000);
    }
    await registerCommands();
});

client.on('interactionCreate', async (int) => {
    if (!int.isChatInputCommand()) return;
    const { commandName, guild, member, channel } = int;

    if (commandName === 'cal') {
        const vChan = member.voice.channel;
        if (!vChan) return int.reply({ content: '❌ Önce bir ses kanalına girmelisin!', ephemeral: true });

        const url = int.options.getString('link');
        if (!play.yt_validate(url)) return int.reply({ content: '❌ Lütfen geçersiz bir YouTube linki girmeyin!', ephemeral: true });

        await int.deferReply();

        try {
            console.log('📡 Şarkı bilgileri alınıyor (yt-dlp)...');
            const meta = await ytdl(url, { dumpSingleJson: true, noCheckCertificates: true, noWarnings: true, addHeader: ['referer:https://www.youtube.com/'] });

            const song = {
                title: meta.title || 'Bilinmeyen Şarkı',
                url: url,
                duration: meta.duration_string || '00:00',
                thumbnail: meta.thumbnail || ''
            };

            let sQueue = queue.get(guild.id);
            if (!sQueue) {
                // Yeni bağlantı oluştur veya mevcut olanı al
                const connection = connectToVoice(vChan);

                const player = createAudioPlayer({
                    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
                });

                // Player durumlarını izle
                player.on('stateChange', (oldState, newState) => {
                    console.log(`🎵 [PLAYER] ${oldState.status} -> ${newState.status}`);

                    if (newState.status === AudioPlayerStatus.Idle) {
                        sQueue.songs.shift();
                        playSong(guild.id);
                    }

                    if (newState.status === AudioPlayerStatus.AutoPaused) {
                        console.log('⚠️ [DÜZELTME] Autopaused algılandı, ses devam ettiriliyor...');
                        player.unpause();
                    }
                });

                player.on('error', e => console.error('❌ Player Hatası:', e.message));

                sQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, sQueue);

                await int.editReply(`🎵 Çalmaya hazırlanıyor: **${song.title}** (${song.duration})`);
                playSong(guild.id);
            } else {
                sQueue.songs.push(song);
                await int.editReply(`📝 Kuyruğa eklendi: **${song.title}** (Sıra: ${sQueue.songs.length})`);
            }
        } catch (e) {
            console.error('❌ CAL komutu hatası:', e);
            await int.editReply(`❌ Şarkı bilgisi alınamadı (YouTube engeli olabilir). Hata: ${e.message}`);
        }
    }

    if (commandName === 'dur') {
        const q = queue.get(guild.id);
        if (q) { q.player.pause(); await int.reply('⏸️ Müzik durduruldu! Devam ettirmek için `/devam` yazın.'); }
        else await int.reply({ content: '❌ Şu an çalan bir müzik yok.', ephemeral: true });
    }

    if (commandName === 'devam') {
        const q = queue.get(guild.id);
        if (q) { q.player.unpause(); await int.reply('▶️ Müzik kaldığı yerden devam ediyor!'); }
        else await int.reply({ content: '❌ Devam ettirilecek bir müzik yok.', ephemeral: true });
    }

    if (commandName === 'atla') {
        const q = queue.get(guild.id);
        if (q) { q.player.stop(); await int.reply('⏭️ Şarkı atlandı, sıradakine geçiliyor.'); }
        else await int.reply({ content: '❌ Atlanacak bir şarkı yok.', ephemeral: true });
    }

    if (commandName === 'kuyruk') {
        const q = queue.get(guild.id);
        if (!q || q.songs.length === 0) return int.reply({ content: '📋 Şu an kuyrukta şarkı bulunmuyor.', ephemeral: true });

        const list = q.songs.slice(0, 10).map((s, i) => `${i === 0 ? '🎵 **Çalıyor:**' : `**${i}.**`} ${s.title}`).join('\n');
        await int.reply(`📋 **Şarkı Kuyruğu (İlk 10):**\n${list}`);
    }

    if (commandName === 'ses') {
        const q = queue.get(guild.id);
        const voltip = int.options.getInteger('seviye');
        if (q) {
            q.volume = voltip;
            if (q.resource && q.resource.volume) q.resource.volume.setVolume(voltip / 100);
            await int.reply(`🔊 Ses seviyesi **%${voltip}** olarak ayarlandı.`);
        } else await int.reply({ content: '❌ Aktif bir müzik yok.', ephemeral: true });
    }

    if (commandName === 'git') {
        const q = queue.get(guild.id);
        if (q) {
            q.songs = [];
            q.player.stop();
            q.connection.destroy();
            queue.delete(guild.id);
        }
        // Failsafe: Her türlü bağlantıyı yok et
        const conn = getVoiceConnection(guild.id);
        if (conn) conn.destroy();

        await int.reply('👋 Kanalı terk ettim ve kuyruğu temizledim.');
        // 2 saniye sonra bekleme kanalına geri dön
        setTimeout(() => returnToWaitChannel(guild.id), 2000);
    }
});

// ─── Hata Yönetimi ───
process.on('unhandledRejection', e => console.error('❌ YAKALANMAMIŞ HATA:', e));
process.on('uncaughtException', e => console.error('❌ KRİTİK HATA:', e));

// ─── Bot Login ───
client.login(process.env.DISCORD_TOKEN);
