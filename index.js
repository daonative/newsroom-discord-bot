require('dotenv').config()

const { Client, Intents, Constants } = require('discord.js');
const admin = require("firebase-admin");
const slugify = require('slugify');

const { getFirestore } = require("firebase-admin/firestore");

const client = new Client({ intents: [Intents.FLAGS.GUILDS] });


admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  }),
});

const getRoomGuildSettings = async (roomName) => {
  try {
    const db = getFirestore()
    const roomDoc = await db.collection('rooms').doc(roomName).get();
    const roomData = roomDoc.data()

    if (!roomData?.discordGuildId || !roomData?.discordAnnouncementsChannelId || !roomData?.discordNewsroomCategoryChannelId) {
      return null
    }

    return {
      guildId: roomData.discordGuildId,
      announcementsChannelId: roomData.discordAnnouncementsChannelId,
      newsroomCategoryChannelId: roomData.discordNewsroomCategoryChannelId,
      bleedingBot: roomData.discordBleedingBot || false,
      prependRoomName: false
    }
  } catch (error) {
    return null
  }
}

const onNewTask = async (task) => {
  let guildSettings = await getRoomGuildSettings(task.room)
  const isBleedingBot = process.env.DISCORD_BLEEDING_BOT === '1'

  // Use default guild settings (if it exists) when the room doesn't have guild settings
  if (!guildSettings && process.env.DISCORD_DEFAULT_GUILD) {
    guildSettings = {
      guildId: process.env.DISCORD_DEFAULT_GUILD,
      announcementsChannelId: process.env.DISCORD_DEFAULT_ANNOUCEMENTS_CHANNEL,
      newsroomCategoryChannelId: process.env.DISCORD_DEFAULT_CATEGORY,
      bleedingBot: false,
      prependRoomName: true
    }
  }

  // Abort if room doesn't have any guild configured
  if (!guildSettings) {
    console.log(task.id, task.room, "was unable to fetch guild settings")
    return
  }

  // Abort if discord connection is meant for bleeding bot and this is not the bleeding bot
  if (guildSettings.bleedingBot !== isBleedingBot) {
    return
  }

  // Abort if task is a welcome task
  if (task.title.startsWith("__Welcome")) {
    console.log(task.id, task.room, "is a welcome task")
    return
  }

  // Abort if task is already announced
  if (task.discordInviteCode) {
    console.log(task.id, task.room, "is already announced")
    return
  }

  // Get the channels
  const guild = client.guilds.cache.get(guildSettings.guildId)
  const announcementsChannel = await guild.channels.fetch(guildSettings.announcementsChannelId)
  const newsroomCategoryChannel = await guild.channels.fetch(guildSettings.newsroomCategoryChannelId)

  // Task link and channel name
  const taskLink = `https://newsroom.xyz/rooms/${task.room}/${task.id}`
  const taskSlug = slugify(task.title).toLowerCase()
  const taskChannelName = `${guildSettings.prependRoomName ? `${task.room}-` : ''}${taskSlug}`

  // Create a task channel
  const taskChannel = await newsroomCategoryChannel.createChannel(taskChannelName)
  taskChannel.send(
    `**${task.title}**
${taskLink}
`)

  // Create the task announcement
  announcementsChannel.send(
    `📰 New task from ${task.room} just dropped:
${taskLink}
Interested? Send a gm in <#${taskChannel.id}>
`)

  // Create invite to the task
  const invite = await taskChannel.createInvite({ maxAge: 0 });
  const db = getFirestore()
  const taskRef = db.collection("tasks").doc(task.id);
  await taskRef.update({
    discordChannelName: taskChannelName,
    discordInviteCode: invite.code,
  });
}

const onRoomConnection = async (room) => {
  const guildId = room.discordGuildId

  // Abort if it already has an annoucments channel
  if (room.discordAnnouncementsChannelId) {
    console.log(room.id, "already has annoucements channel")
    return
  }

  // Get the guild by id
  const guild = client.guilds.cache.get(guildId);

  // Create the newsroom category
  const newsroomCategory = await guild.channels.create("newsroom", { type: Constants.ChannelTypes.GUILD_CATEGORY })
  console.log(room.id, "create newsroom category", newsroomCategory.id)

  // Create the annoucements channel
  const annoucementsChannel = await newsroomCategory.createChannel("new-tasks", { type: Constants.ChannelTypes.GUILD_TEXT })
  console.log(room.id, "create annoucements channel", annoucementsChannel.id)

  // Save the channel ids
  const db = getFirestore()
  const roomRef = db.collection('rooms').doc(room.id);
  await roomRef.update({
    discordAnnouncementsChannelId: annoucementsChannel.id,
    discordNewsroomCategoryChannelId: newsroomCategory.id
  });
}

const listenForNewTasks = () => {
  const start = new Date('Nov 23, 2021 12:00:01 GMT+00:00')
  const db = getFirestore();
  db
    .collection('tasks')
    .where('created', '>', start)
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        if (change.type !== "added") {
          return;
        }

        try {
          const task = { id: change.doc.id, ...change.doc.data() }
          onNewTask(task);
        } catch (error) {
          console.error(error)
        }
      })
    });
}

const listenForRoomConnections = () => {
  const db = getFirestore()
  db
    .collection('rooms')
    .where('discordGuildId', '!=', '')
    .onSnapshot((querySnapshot) => {
      querySnapshot.docChanges().forEach(change => {
        // Added in this case means going from no discordGuildId to having one
        if (change.type !== "added") {
          return;
        }

        try {
          const room = { id: change.doc.id, ...change.doc.data() }
          onRoomConnection(room)
        } catch (error) {
          console.error(error)
        }
      })
    });
}

client.once('ready', () => {
  console.log('Ready!');
  listenForNewTasks();
  listenForRoomConnections();
});

client.login(process.env.DISCORD_TOKEN);