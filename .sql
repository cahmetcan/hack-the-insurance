-- wrangler d1 execute database --command

CREATE TABLE IF NOT EXISTS
    conversations (
        id INTEGER PRIMARY KEY,
        request TEXT NOT NULL,
        response TEXT NOT NULL
    )