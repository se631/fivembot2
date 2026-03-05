const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const play = require('play-dl');
const ytdl = require('yt-dlp-exec');
const stream = require('stream');

// Railway ortam değişkenlerini doğrudan process.env üzerinden okuyoruz
// Railway Dashboard > Variables kısmından şu değişkenleri ekleyin:
// DISCORD_TOKEN, CLIENT_ID, WAIT_CHANNEL_ID, WAIT_GUILD_ID

// ─── Bot Client ───
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─── Global değişkenler ───
const queue = new Map(); // guild bazlı kuyruk sistemi

// ─── Slash Komutları Tanımla ───
const commands = [
    new SlashCommandBuilder()
        .setName('gel')
        .setDescription('Botu ses kanalına çağırır'),
    new SlashCommandBuilder()
        .setName('cal')
        .setDescription('YouTube linkini çalar')
        .addStringOption(option =>
            option.setName('link')
                .setDescription('YouTube linki')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('dur')
        .setDescription('Çalan müziği duraklatır'),
    new SlashCommandBuilder()
        .setName('devam')
        .setDescription('Duraklatılan müziği devam ettirir'),
    new SlashCommandBuilder()
        .setName('atla')
        .setDescription('Sıradaki şarkıya geçer'),
    new SlashCommandBuilder()
        .setName('kuyruk')
        .setDescription('Şarkı kuyruğunu gösterir'),
    new SlashCommandBuilder()
        .setName('ses')
        .setDescription('Ses seviyesini ayarlar')
        .addIntegerOption(option =>
            option.setName('seviye')
                .setDescription('Ses seviyesi (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)),
    new SlashCommandBuilder()
        .setName('git')
        .setDescription('Botu ses kanalından çıkarır ve kuyruğu temizler'),
].map(cmd => cmd.toJSON());

// ─── Komutları Discord'a Kaydet ───
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Slash komutları kaydediliyor...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('✅ Slash komutları başarıyla kaydedildi!');
    } catch (error) {
        console.error('❌ Komut kayıt hatası:', error);
    }
}

// ─── Bot Hazır ───
client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} olarak giriş yapıldı!`);

    // Streaming (Yayın) aktivitesi ayarla
    client.user.setPresence({
        activities: [{
            name: 'Developed By Mortex',
            type: ActivityType.Streaming,
            url: 'https://www.twitch.tv/mortex' // Twitch linki gerekli (streaming için)
        }],
        status: 'online'
    });

    console.log('🎥 Yayın durumu: "Developed By Mortex" olarak ayarlandı.');

    // Varsayılan bekleme kanalına katıl
    const waitChannelId = process.env.WAIT_CHANNEL_ID;
    const waitGuildId = process.env.WAIT_GUILD_ID;

    if (waitChannelId && waitGuildId) {
        try {
            const guild = await client.guilds.fetch(waitGuildId);
            const channel = await guild.channels.fetch(waitChannelId);

            if (channel && channel.isVoiceBased()) {
                const connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfDeaf: true,  // Kulaklık kapalı
                    selfMute: false  // Mikrofon açık
                });

                console.log(`🔇 Bekleme kanalına katıldı: #${channel.name} (Mikrofon açık, kulaklık kapalı)`);

                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    // Eğer aktif bir müzik kuyruğu varsa, bekleme kanalına zorla döndürme
                    if (queue.has(guild.id)) return;

                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                    } catch {
                        // Eğer hala bağlı değilsek ve kuyruk yoksa bekleme kanalına dön
                        if (queue.has(guild.id)) return;

                        console.log('🔄 Bekleme kanalına yeniden bağlanılıyor...');
                        try {
                            joinVoiceChannel({
                                channelId: channel.id,
                                guildId: guild.id,
                                adapterCreator: guild.voiceAdapterCreator,
                                selfDeaf: true,
                                selfMute: false
                            });
                        } catch (e) {
                            console.error('❌ Yeniden bağlanma hatası:', e);
                        }
                    }
                });
            }
        } catch (error) {
            console.error('❌ Bekleme kanalına katılma hatası:', error);
        }
    }

    await registerCommands();
});

// ─── Şarkı Çalma Fonksiyonu ───
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        // Kuyruk bitti, bekleme kanalına dön
        const waitChannelId = process.env.WAIT_CHANNEL_ID;
        const waitGuildId = process.env.WAIT_GUILD_ID;

        if (serverQueue && serverQueue.connection) {
            if (waitChannelId && waitGuildId && guildId === waitGuildId) {
                // Bekleme kanalına geri dön
                try {
                    const guild = await client.guilds.fetch(waitGuildId);
                    const channel = await guild.channels.fetch(waitChannelId);
                    joinVoiceChannel({
                        channelId: channel.id,
                        guildId: guild.id,
                        adapterCreator: guild.voiceAdapterCreator,
                        selfDeaf: true,
                        selfMute: false
                    });
                    console.log('🔇 Bekleme kanalına geri dönüldü.');
                } catch (e) {
                    console.error('❌ Bekleme kanalına dönme hatası:', e);
                }
            } else {
                serverQueue.connection.destroy();
            }
        }
        queue.delete(guildId);
        return;
    }

    const song = serverQueue.songs[0];

    try {
        console.log(`📡 Stream başlatılıyor: ${song.title}`);

        // yt-dlp-exec kullanımı (YouTube IP engellerini aşmak için daha etkilidir)
        const output = ytdl.exec(song.url, {
            output: '-',
            format: 'bestaudio/best',
            limitRate: '1M',
        }, { stdio: ['ignore', 'pipe', 'ignore'] });

        if (!output.stdout) {
            throw new Error('Stream oluşturulamadı.');
        }

        const resource = createAudioResource(output.stdout, {
            inlineVolume: true
        });

        // Ses seviyesi ayarla
        resource.volume.setVolume(serverQueue.volume / 100);
        serverQueue.resource = resource;

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log('✅ Şarkı çalmaya başladı.');

        // Not: Mikrofon ayarları joinVoiceChannel aşamasında zaten yapıldı.
        // rejoin() çağırmak bağlantı sorunlarına yol açabildiği için kaldırıldı.

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            console.log('🎵 Şarkı bitti, sıradakine geçiliyor...');
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

        serverQueue.player.once('error', error => {
            console.error('❌ Çalma hatası:', error);
            if (serverQueue.textChannel) {
                serverQueue.textChannel.send(`❌ Ses çalma hatası: ${error.message}`).catch(() => { });
            }
            serverQueue.songs.shift();
            playSong(guildId, interaction);
        });

    } catch (error) {
        console.error('❌ Stream hatası:', error);
        if (serverQueue.textChannel) {
            serverQueue.textChannel.send(`❌ Şarkı çalınamadı: ${error.message || 'Bilinmeyen hata'}. Sıradakine geçiliyor...`).catch(() => { });
        }
        serverQueue.songs.shift();
        playSong(guildId, interaction);
    }
}

// ─── Slash Komut İşleyicisi ───
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    // ═══ /gel komutu ═══
    if (commandName === 'gel') {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Önce bir ses kanalına katılmalısın!', ephemeral: true });
        }

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true,  // Kulaklık kapalı
                selfMute: false  // Mikrofon açık
            });

            await interaction.reply(`✅ **${voiceChannel.name}** kanalına katıldım! 🎵\nMüzik çalmak için \`/cal\` komutunu kullan.`);
        } catch (error) {
            console.error('❌ Kanala katılma hatası:', error);
            await interaction.reply({ content: '❌ Ses kanalına katılamadım!', ephemeral: true });
        }
    }

    // ═══ /cal komutu ═══
    else if (commandName === 'cal') {
        const voiceChannel = member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Önce bir ses kanalına katılmalısın!', ephemeral: true });
        }

        const url = interaction.options.getString('link');

        // YouTube linki kontrolü
        if (!play.yt_validate(url)) {
            return interaction.reply({ content: '❌ Geçerli bir YouTube linki gir!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            let info;
            try {
                info = await play.video_basic_info(url);
            } catch (e) {
                console.log('⚠️ play-dl info alamadı, alternatif yöntem deneniyor...');
                // Eğer play-dl hata verirse (link kontrolü hatası), yt-dlp ile temel bilgiyi almayı deneyebiliriz
                // Ancak şimdilik play-dl'i daha dikkatli kullanacağız.
                return interaction.editReply('❌ Şarkı bilgisi alınamadı! YouTube erişimi engellenmiş olabilir veya link hatalı.');
            }

            const song = {
                title: info.video_details.title,
                url: url,
                duration: info.video_details.durationRaw,
                thumbnail: info.video_details.thumbnails[0]?.url
            };

            const serverQueue = queue.get(guild.id);

            if (serverQueue) {
                // Kuyruğa ekle
                serverQueue.songs.push(song);
                return interaction.editReply(`📝 Kuyruğa eklendi: **${song.title}** (${song.duration})\n📋 Sıra: ${serverQueue.songs.length}`);
            }

            // Ses kanalına katıl veya kanalı değiştir
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            console.log(`🎵 ${voiceChannel.name} kanalında çalmaya başlanıyor...`);

            const player = createAudioPlayer();
            const queueData = {
                connection,
                player,
                songs: [song],
                volume: 50,
                textChannel: interaction.channel
            };

            queue.set(guild.id, queueData);

            await interaction.editReply(`🎵 Çalınıyor: **${song.title}** (${song.duration})`);
            playSong(guild.id, interaction);

        } catch (error) {
            console.error('❌ Şarkı bilgisi alma hatası:', error);
            await interaction.editReply('❌ Şarkı bilgisi alınamadı! Link\'i kontrol et.');
        }
    }

    // ═══ /dur komutu ═══
    else if (commandName === 'dur') {
        const serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            return interaction.reply({ content: '❌ Şu anda çalan bir şarkı yok!', ephemeral: true });
        }

        serverQueue.player.pause();
        await interaction.reply('⏸️ Müzik duraklatıldı! Devam ettirmek için `/devam` yaz.');
    }

    // ═══ /devam komutu ═══
    else if (commandName === 'devam') {
        const serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            return interaction.reply({ content: '❌ Duraklatılmış bir şarkı yok!', ephemeral: true });
        }

        serverQueue.player.unpause();
        await interaction.reply('▶️ Müzik devam ediyor!');
    }

    // ═══ /atla komutu ═══
    else if (commandName === 'atla') {
        const serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            return interaction.reply({ content: '❌ Atlanacak şarkı yok!', ephemeral: true });
        }

        serverQueue.player.stop();
        await interaction.reply('⏭️ Şarkı atlandı!');
    }

    // ═══ /kuyruk komutu ═══
    else if (commandName === 'kuyruk') {
        const serverQueue = queue.get(guild.id);
        if (!serverQueue || serverQueue.songs.length === 0) {
            return interaction.reply({ content: '📋 Kuyruk boş!', ephemeral: true });
        }

        const songList = serverQueue.songs.map((song, index) => {
            const prefix = index === 0 ? '🎵 Şu an çalıyor' : `${index}`;
            return `**${prefix}.** ${song.title} (${song.duration})`;
        }).join('\n');

        await interaction.reply(`📋 **Şarkı Kuyruğu:**\n${songList}`);
    }

    // ═══ /ses komutu ═══
    else if (commandName === 'ses') {
        const serverQueue = queue.get(guild.id);
        if (!serverQueue) {
            return interaction.reply({ content: '❌ Şu anda çalan bir şarkı yok!', ephemeral: true });
        }

        const volume = interaction.options.getInteger('seviye');
        serverQueue.volume = volume;
        // Çalan şarkının ses seviyesini de anında değiştir
        if (serverQueue.resource && serverQueue.resource.volume) {
            serverQueue.resource.volume.setVolume(volume / 100);
        }
        await interaction.reply(`🔊 Ses seviyesi **${volume}%** olarak ayarlandı!`);
    }

    // ═══ /git komutu ═══
    else if (commandName === 'git') {
        const serverQueue = queue.get(guild.id);

        if (serverQueue) {
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.connection.destroy();
            queue.delete(guild.id);
        }

        // Bekleme kanalına dön
        const waitChannelId = process.env.WAIT_CHANNEL_ID;
        const waitGuildId = process.env.WAIT_GUILD_ID;

        if (waitChannelId && waitGuildId && guild.id === waitGuildId) {
            try {
                const waitGuild = await client.guilds.fetch(waitGuildId);
                const waitChannel = await waitGuild.channels.fetch(waitChannelId);
                joinVoiceChannel({
                    channelId: waitChannel.id,
                    guildId: waitGuild.id,
                    adapterCreator: waitGuild.voiceAdapterCreator,
                    selfDeaf: true,
                    selfMute: false
                });
                await interaction.reply('👋 Kanaldan ayrıldım ve bekleme kanalına döndüm!');
            } catch (e) {
                await interaction.reply('👋 Kanaldan ayrıldım!');
            }
        } else {
            await interaction.reply('👋 Kanaldan ayrıldım!');
        }
    }
});

// ─── Hata Yakalama ───
process.on('unhandledRejection', error => {
    console.error('❌ Yakalanmamış hata:', error);
});

process.on('uncaughtException', error => {
    console.error('❌ Kritik hata:', error);
});

// ─── Bot'u Başlat ───
client.login(process.env.DISCORD_TOKEN);
