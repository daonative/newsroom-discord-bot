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
      return
    }

    return {
      guildId: roomData.discordGuildId,
      announcementsChannelId: roomData.discordAnnouncementsChannelId,
      newsroomCategoryChannelId: roomData.discordNewsroomCategoryChannelId
    }
  } catch (error) {
    console.log(error)
    return null
  }
}

const onNewTask = async (task) => {
  guildSettings = await getRoomGuildSettings(task.room)

  // Abort if room doesn't have any guild configured
  if (!guildSettings) {
    console.log(task.id, task.room, "has no guild settings")
    return
  }

  // Abort if task is already announced
  if (task.discordInviteCode) {
    console.log(task.id, "is already announced")
    return
  }

  // Get the channels
  console.log(guildSettings)
  const guild = client.guilds.cache.get(guildSettings.guildId)
  const announcementsChannel = await guild.channels.fetch(guildSettings.announcementsChannelId)
  const newsroomCategoryChannel = await guild.channels.fetch(guildSettings.newsroomCategoryChannelId)

  // Create a task channel
  const taskSlug = slugify(task.title)
  const taskChannel = await newsroomCategoryChannel.createChannel(taskSlug)

  // Create the task annoucement
  const taskLink = `https://newsroom.xyz/rooms/${task.room}/${task.id}`
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
  const annoucementsChannel = await newsroomCategory.createChannel("announcements", { type: Constants.ChannelTypes.GUILD_TEXT })
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
  const db = getFirestore();
  db
    .collection('tasks')
    .onSnapshot((querySnapshot) => {
    querySnapshot.docChanges().forEach(change => {
      if (change.type !== "added") {
        return;
      }

      const task = { id: change.doc.id, ...change.doc.data() }
      onNewTask(task);
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

        const room = { id: change.doc.id, ...change.doc.data() }
        onRoomConnection(room)
      })
    });
}

client.once('ready', () => {
  console.log('Ready!');
  listenForNewTasks();
  listenForRoomConnections();
});

client.login(process.env.DISCORD_TOKEN);
