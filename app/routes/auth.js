const express = require("express");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// Google OAuth client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Register new user
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: "Name, email and password are required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      return res.status(400).json({
        message: "Invalid email format",
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        message: "Email already registered",
      });
    }

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });

    const userResult = await pool.query(
      `INSERT INTO users
        (name, email, password_hash, auth_provider)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, auth_provider, created_at`,
      [name, email, passwordHash, "local"]
    );

    const user = userResult.rows[0];

    await pool.query(
      `INSERT INTO accounts (user_id)
       VALUES ($1)`,
      [user.id]
    );

    return res.status(201).json({
      message: "Registration successful",
      user,
    });
  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      message: "Something went wrong while registering",
    });
  }
});

// Login user
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, auth_provider
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      return res.status(401).json({
        message: "This account uses Google login",
      });
    }

    const passwordMatch = await argon2.verify(
      user.password_hash,
      password
    );
    if (!passwordMatch) {
      return res.status(401).json({
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        auth_provider: user.auth_provider,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      message: "Something went wrong while logging in",
    });
  }
});

// Start Google OAuth login
router.get("/google", (req, res) => {
  const authorizationUrl = googleClient.generateAuthUrl({
    access_type: "offline",
    scope: [
      "openid",
      "email",
      "profile",
    ],
    prompt: "select_account",
  });

  return res.redirect(authorizationUrl);
});

// Google OAuth callback
router.get("/google/callback", async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.status(400).json({
        message: "Google login was cancelled or failed",
        error,
      });
    }

    if (!code) {
      return res.status(400).json({
        message: "Google authorization code is missing",
      });
    }

    // Exchange authorization code for Google tokens
    const { tokens } = await googleClient.getToken(code);

    if (!tokens.id_token) {
      return res.status(401).json({
        message: "Google ID token was not received",
      });
    }

    // Verify Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(401).json({
        message: "Unable to verify Google account",
      });
    }

    const googleEmail = payload.email;
    const googleName = payload.name || "Google User";

    // Check if user already exists
    const existingUser = await pool.query(
      `SELECT id, name, email, auth_provider
       FROM users
       WHERE email = $1`,
      [googleEmail]
    );

    let user;

    if (existingUser.rows.length > 0) {
      user = existingUser.rows[0];

      // Update auth provider if this is a Google login
      if (user.auth_provider !== "google") {
        const updatedUser = await pool.query(
          `UPDATE users
           SET auth_provider = 'google'
           WHERE id = $1
           RETURNING id, name, email, auth_provider`,
          [user.id]
        );

        user = updatedUser.rows[0];
      }
    } else {
      // Create new Google user
      const userResult = await pool.query(
        `INSERT INTO users
          (name, email, password_hash, auth_provider)
         VALUES ($1, $2, NULL, $3)
         RETURNING id, name, email, auth_provider`,
        [googleName, googleEmail, "google"]
      );

      user = userResult.rows[0];

      // Create account metadata
      await pool.query(
        `INSERT INTO accounts (user_id)
         VALUES ($1)`,
        [user.id]
      );
    }

    // Create ClipCraft JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    return res.status(200).json({
      message: "Google login successful",
      token,
      user,
    });
  } catch (error) {
    console.error("Google OAuth error:", error);

    return res.status(500).json({
      message: "Google login failed",
    });
  }
});
// Update current user's profile
router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name && !email) {
      return res.status(400).json({
        message: "Name or email is required",
      });
    }

    // Check if email is already used by another user
    if (email) {
      const existingUser = await pool.query(
        `SELECT id
         FROM users
         WHERE email = $1 AND id != $2`,
        [email, req.user.userId]
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          message: "Email already registered",
        });
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email)
       WHERE id = $3
       RETURNING id, name, email, auth_provider`,
      [
        name,
        email,
        req.user.userId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Update profile error:", error);

    return res.status(500).json({
      message: "Something went wrong while updating profile",
    });
  }
});
// Get current logged-in user
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, auth_provider
       FROM users
       WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    return res.status(200).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Get user error:", error);

    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }
});

module.exports = router;