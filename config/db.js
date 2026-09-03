import mongoose from "mongoose";

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Połączono z MongoDB Atlas ✔");
  } catch (error) {
    console.error("Błąd połączenia z MongoDB ❌", error);
    process.exit(1);
  }
};

mongoose.connection.on("error", (err) => {
  console.error("Błąd MongoDB (po połączeniu) ❌:", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("Utracono połączenie z MongoDB ⚠️");
});

mongoose.connection.on("connected", () => {
  console.log("Ponownie połączono z MongoDB 🔄");
});

export default connectDB;
