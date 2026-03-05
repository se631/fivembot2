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
const play = require('play-dl'); // En kararlı kütüphane

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
 * SES KANALINA BAĞLANMA (AĞ DÜZELTİCİ V6)
 */
function manageVoiceConnection(channel) {
    const guildId = channel.guild.id;
    let connection = getVoiceConnection(guildId);

    if (connection) {
        if (connection.joinConfig.channelId !== channel.id) {
            console.log(`🔄 [GEÇİŞ] Kanal değiştiriliyor: #${channel.name}`);
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

    // DÖNGÜ KIRICI SİSTEM
    const timeout = setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            console.log('⚠️ [AĞ HATASI] Sinyal döngüsü algılandı. Bağlantı sıfırlanıyor...');
            connection.destroy();
            // 2 saniye sonra temiz bir bağlantı dene
            setTimeout(() => manageVoiceConnection(channel), 2000);
        }
    }, 15000);

    connection.on('stateChange', (oldState, newState) => {
        console.log(`🌐 [DURUM] ${oldState.status} -> ${newState.status}`);
        if (newState.status === VoiceConnectionStatus.Ready) {
            clearTimeout(timeout);
            console.log('✅ [HAZIR] Discord ses sunucusuyla tam bağlantı kuruldu!');
        }
    });

    return connection;
}

/**
 * ŞARKI OYNATMA (play-dl MOTORU)
 */
async function playSong(guildId, interaction) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        return finalizeQueue(guildId);
    }

    const song = serverQueue.songs[0];
    try {
        console.log(`📡 Yayına Hazırlanıyor (play-dl): ${song.title}`);

        // play-dl ile YouTube Stream alma
        let stream = await play.stream(song.url, {
            discordPlayerCompatibility: true,
            quality: 2 // Highest audio quality
        });

        const resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: true
        });

        resource.volume.setVolume(serverQueue.volume / 100);

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        console.log(`✅ [PLAYING] ${song.title}`);

    } catch (err) {
        console.error('❌ Oynatma Hatası:', err.message);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ Şarkı çalınamadı (YouTube Engeli). Sıradakine geçiliyor...`).catch(() => { });
        serverQueue.songs.shift();
        playSong(guildId, interaction);
    }
}

/**
 * KUYRUK TEMİZLİĞİ VE DÖNÜŞ
 */
async function finalizeQueue(guildId) {
    const serverQueue = queue.get(guildId);
    const waitCID = process.env.WAIT_CHANNEL_ID;
    const waitGID = process.env.WAIT_GUILD_ID;

    if (waitCID && waitGID && guildId === waitGID) {
        try {
            const guild = await client.guilds.fetch(waitGID);
            const channel = await guild.channels.fetch(waitCID);
            if (channel) manageVoiceConnection(channel);
        } catch (e) { console.error('Geri dönüş hatası:', e); }
    } else {
        if (serverQueue && serverQueue.connection) serverQueue.connection.destroy();
    }
    queue.delete(guildId);
}

// ─── Slash Komutları ───
const commands = [
    new SlashCommandBuilder().setName('gel').setDescription('Sese botu çağırır'),
    new SlashCommandBuilder().setName('cal').setDescription('Müzik çalar').addStringOption(o => o.setName('link').setDescription('Youtube Linki').setRequired(true)),
    new SlashCommandBuilder().setName('dur').setDescription('Durdurur'),
    new SlashCommandBuilder().setName('devam').setDescription('Devam ettirir'),
    new SlashCommandBuilder().setName('atla').setDescription('Şarkı atlar'),
    new SlashCommandBuilder().setName('git').setDescription('Kanaldan çıkar'),
    new SlashCommandBuilder().setName('ses').setDescription('Ses (1-100)').addIntegerOption(o => o.setName('seviye').setRequired(true)),
    new SlashCommandBuilder().setName('kuyruk').setDescription('Listeyi gösterir'),
].map(c => c.toJSON());

// ─── Bot Events ───
client.once('clientReady', async () => {
    console.log(`🚀 [AKTİF] ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Developed By Mortex', type: ActivityType.Streaming, url: 'https://twitch.tv/mortex' }], status: 'online' });

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Komutlar kaydedildi.');

    // Başlangıçta bekleme kanalına gir (10 saniye sonra)
    setTimeout(async () => {
        const wCID = process.env.WAIT_CHANNEL_ID;
        const wGID = process.env.WAIT_GUILD_ID;
        if (wCID && wGID) {
            try {
                const g = await client.guilds.fetch(wGID);
                const c = await g.channels.fetch(wCID);
                if (c) manageVoiceConnection(c);
            } catch (e) { console.error('Başlangıç sese bağlanma hatası:', e); }
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
        if (!url.includes('youtube.com') && !url.includes('youtu.be')) return interaction.reply({ content: '❌ Geçersiz link!', ephemeral: true });

        await interaction.deferReply();

        try {
            console.log('📡 Şarkı bilgisi alınıyor (play-dl)...');
            const songInfo = await play.video_info(url);
            const song = { title: songInfo.video_details.title, url: url, duration: songInfo.video_details.durationRaw };

            let serverQueue = queue.get(guild.id);
            if (!serverQueue) {
                const connection = manageVoiceConnection(vChannel);
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                player.on('stateChange', (o, n) => {
                    if (n.status === AudioPlayerStatus.Idle) {
                        serverQueue.songs.shift();
                        playSong(guild.id, interaction);
                    }
                    if (n.status === AudioPlayerStatus.AutoPaused) player.unpause();
                });

                serverQueue = { connection, player, songs: [song], volume: 50, textChannel: channel };
                queue.set(guild.id, serverQueue);

                await interaction.editReply(`🎵 Çalınıyor: **${song.title}**`);

                // Bağlantının hazır olmasını bekle
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
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

    if (commandName === 'kuyruk') {
        const q = queue.get(guild.id);
        if (!q || q.songs.length === 0) return interaction.reply('📋 Kuyruk boş.');
        const list = q.songs.map((s, i) => `${i === 0 ? '🎵' : i + '.'} ${s.title}`).join('\n');
        await interaction.reply(`� **Kuyruk:**\n${list}`);
    }

    if (commandName === 'git') {
        const q = queue.get(guild.id);
        if (q) {
            q.songs = [];
            q.player.stop();
            q.connection.destroy();
            queue.delete(guild.id);
        }
        await interaction.reply('� Çıkış yapıldı.');
        setTimeout(() => finalizeQueue(guild.id), 2000);
    }
});

process.on('unhandledRejection', e => console.error('Hata:', e));
client.login(process.env.DISCORD_TOKEN);
