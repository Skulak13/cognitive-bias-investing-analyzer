import mongoose from "mongoose";

const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Połączono z MongoDB Atlas ✔");
};

mongoose.connection.on("error", (err) => {
  console.error("Błąd MongoDB (po połączeniu) ❌:", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("Utracono połączenie z MongoDB ⚠️");
});

mongoose.connection.on("reconnected", () => {
  console.log("Ponownie połączono z MongoDB 🔄");
});

export default connectDB;
