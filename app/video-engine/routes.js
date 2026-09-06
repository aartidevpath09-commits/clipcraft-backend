const express = require("express");

const { renderVideo } = require("./controllers/render-controller");

const router = express.Router();

router.post("/render", renderVideo);

module.exports = router;