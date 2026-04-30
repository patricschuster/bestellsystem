// src/db.js (Option B seed, v2.9)
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname,'..','data');
const DB_PATH = path.join(DATA_DIR,'bestellsystem.db');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
export const db = new Database(DB_PATH);

export function ensureInitialized(){
  db.pragma('foreign_keys=ON');

  // Check if waiter_sessions table exists, create if not
  const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='waiter_sessions'").get();
  if(!hasSessions){
    db.exec(`
      CREATE TABLE waiter_sessions(
        waiter TEXT PRIMARY KEY,
        last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    console.log('waiter_sessions table created.');
  }

  // Check if station_sessions table exists, create if not
  const hasStationSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='station_sessions'").get();
  if(!hasStationSessions){
    db.exec(`
      CREATE TABLE station_sessions(
        station TEXT PRIMARY KEY,
        last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    console.log('station_sessions table created.');
  }

  // Create settings table for PINs if not exists
  const hasSettings = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if(!hasSettings){
    db.exec(`
      CREATE TABLE settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO settings(key, value) VALUES
        ('pin_bar', '4711'),
        ('pin_admin', '0815');
    `);
    console.log('Settings table created with default PINs.');
  }

  // Create main tables if they don't exist yet (fresh database)
  const hasProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
  if(!hasProducts){
    const sql = `
PRAGMA foreign_keys=ON;
CREATE TABLE products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  color TEXT,
  half INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE tables(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);
CREATE TABLE orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL,
  waiter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  paid INTEGER DEFAULT 0,
  comment TEXT
);
CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR REPLACE INTO config(key,value) VALUES ('product_order','[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]');
INSERT INTO tables(name) VALUES (NULL),(NULL),(NULL),(NULL),(NULL),(NULL),(NULL),(NULL),
                               (NULL),(NULL),(NULL),(NULL),(NULL),(NULL),(NULL),(NULL);
DELETE FROM products;
INSERT INTO products(id,name,price_cents,color,half,active) VALUES
 (1,'Bier Maß',700,'#fcefb4',0,1),
 (2,'Bier 1/2',350,'#fcefb4',1,1),
 (3,'Radler Maß',650,'#fcefb4',0,1),
 (4,'Radler 1/2',330,'#fcefb4',1,1),
 (5,'Weizen',330,'#fcefb4',0,1),
 (6,'Schwarze',300,'#c7c7c7',0,1),
 (7,'Schwarze 1/2',250,'#c7c7c7',1,1),
 (8,'Laterne Maß',650,'#f6b2b5',0,1),
 (9,'Laterne 1/2',330,'#f6b2b5',1,1),
 (10,'Alkfrei Bier',350,'#a7c7e7',0,1),
 (11,'W-Sch Süß',280,NULL,0,1),
 (12,'W-Sch Sauer',280,NULL,0,1),
 (13,'Spezi',280,'#a7c7e7',0,1),
 (14,'Limo Gelb',250,'#a7c7e7',0,1),
 (15,'Limo Weiß',250,'#a7c7e7',0,1),
 (16,'Cola',280,'#a7c7e7',0,1),
 (17,'A-Schorle',300,'#a7c7e7',0,1),
 (18,'Wasser',220,'#a7c7e7',0,1);
`;
    db.exec(sql);
    console.log('Database initialized (Option B seed).');
  }

  // --- Spalten-Migrationen (laufen NACH der Tabellenerstellung) ---

  // order_items: 'paid' Spalte hinzufügen falls nicht vorhanden
  const hasOrderItems = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='order_items'").get();
  if(hasOrderItems){
    const hasPaidColumn = db.prepare("PRAGMA table_info(order_items)").all().find(col => col.name === 'paid');
    if(!hasPaidColumn){
      // Kein NOT NULL hier – ältere SQLite-Versionen erlauben das bei ALTER TABLE nicht
      db.exec('ALTER TABLE order_items ADD COLUMN paid INTEGER DEFAULT 0');
      console.log('Added paid column to order_items');
    }

    // order_items: 'comment' Spalte hinzufügen falls nicht vorhanden
    const hasCommentColumn = db.prepare("PRAGMA table_info(order_items)").all().find(col => col.name === 'comment');
    if(!hasCommentColumn){
      db.exec('ALTER TABLE order_items ADD COLUMN comment TEXT');
      console.log('Added comment column to order_items');
    }

    // order_items: 'cancelled' Spalte hinzufügen falls nicht vorhanden
    const hasCancelledColumn = db.prepare("PRAGMA table_info(order_items)").all().find(col => col.name === 'cancelled');
    if(!hasCancelledColumn){
      db.exec('ALTER TABLE order_items ADD COLUMN cancelled INTEGER DEFAULT 0');
      console.log('Added cancelled column to order_items');
    }
  }

  // products: 'station' Spalte hinzufügen falls nicht vorhanden
  const hasProductsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
  if(hasProductsTable){
    const hasStationColumn = db.prepare("PRAGMA table_info(products)").all().find(col => col.name === 'station');
    if(!hasStationColumn){
      db.exec('ALTER TABLE products ADD COLUMN station TEXT');
      console.log('Added station column to products');
    }
  }

  // Erstelle POS-Tisch falls nicht vorhanden
  const hasTablesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tables'").get();
  if(hasTablesTable){
    const hasPOSTable = db.prepare("SELECT * FROM tables WHERE name='POS'").get();
    if(!hasPOSTable){
      db.prepare("INSERT INTO tables(name) VALUES('POS')").run();
      console.log('POS table entry created.');
    }
  }
}
