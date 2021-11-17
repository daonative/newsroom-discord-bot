require('dotenv').config()

const { Client, Intents } = require('discord.js');
const admin = require("firebase-admin");

const { getFirestore } = require("firebase-admin/firestore");

const client = new Client({ intents: [Intents.FLAGS.GUILDS] });


admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  }),
});

const onNewTask = (task) => {
  console.log(task)
}

const onRoomConnection = async (room) => {
  const guildId = room.discordGuildId

  // Abort if it already has an annoucments channel
  if (room.discordAnnouncementsChannelId) {
    console.log(room.id, "already has annoucements channel")
    return
  }

  // Get the guild by id and create the channel
  const guild = client.guilds.cache.get(guildId);
  const channel = await guild.channels.create("newsroom-announcements", { type: "text" })
  console.log(room.id, "create annoucements channel", channel.id)

  // Save the channel id
  const db = getFirestore()
  const roomRef = db.collection('rooms').doc(room.id);
  await roomRef.update({discordAnnouncementsChannelId: channel.id});
}

const listenForNewTasks = () => {
  const db = getFirestore();
  db.collection('tasks').onSnapshot((querySnapshot) => {
    querySnapshot.docChanges().forEach(change => {
      if (change.type !== "added") {
        return;
      }

      const task = { id: change.doc.id, ...change.doc.data()}
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
  //listenForNewTasks();
  listenForRoomConnections();
});

client.login(process.env.DISCORD_TOKEN);
