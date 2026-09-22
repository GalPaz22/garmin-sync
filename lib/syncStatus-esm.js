// lib/syncStatus-esm.js
import clientPromise from "./mongodb.js";

export async function appendLogs(dbName, newLogs, collectionName = "sync_status") {
  if (!newLogs || newLogs.length === 0) return;

  const client = await clientPromise;
  await client
    .db("users")
    .collection(collectionName)
    .updateOne(
      { dbName },
      { $push: { logs: { $each: newLogs } } }
    );
} 