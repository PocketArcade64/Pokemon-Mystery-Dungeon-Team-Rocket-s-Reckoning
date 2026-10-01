Mystery Dungeon: Team Rocket’s Reckoning

Each run has 5 randomized floors but there is a pool of 11 themed floors (added a beach floor) selected at random. The themes and associated music tracks are:
Forest - Apple Woods
Cavern - Aegis Cave
Volcano - Steam Cave
Ice -  Vast Ice Mountain Peak
Water - Drenched Bluff
Ruins - Hidden Land
Rocket Warehouse - Temporal Tower
Desert - Quicksand Cave
Swamp - Barren Valley
Crystal Caves - Crystal Cave
Beach - Beach Cave

Main Menu Theme - Pokemon Exploration Team Theme
Battle Theme for team rocket at end of floor - Dark Wasteland
Giovanni Battle Theme - Dialga’s Fight to the Finish
When you encounter a Pokemon - Wild Pokemon Battle

Updates

This is a major update - please methodically plan out how you will approach this change and ask any necessary clarifying questions before proceeding: 
✅ Please redesign how the rooms randomly generate on- I feel like some of the walls can block your visibility - what is the best way to handle this? Maybe lower the walls to be half a block tall?
✅ Additionally, I want to make all rooms larger - Make all floors 5x larger and the rooms varying sizes and shapes (not all rectangles or squares) - I want this to feel like a real dungeon exploration game. 
✅ Make the mini map be from the same orientation you are looking at (If you click the mini map, it opens the same pause menu and you can rotate/zoom in the map)
✅ Change the player minimap icon to be a green arrow that changes direction based on where you are facing, change the team rocket icon to be a pixel art capital R.

✅ For the items that randomly generate on the floor, make them all rotate in place. If the item is a poke ball, use its associated poke ball model. If it is anything else, use the gift box present 3d model, but when you pick it up, show the sprite of what the item you collected was. Also add the 3 types of coins to spawn on the floor. Also, make every floor have at least 15 poke balls to be acquired. (If you see a poke ball on the ground, it can contain 1-5 poke balls of that type. but each floor has at least 15 in total) 
✅ - On the fourth floor somewhere there is a guaranteed Kecleon shop somewhere on that floor (Kecleon standing on a blanket like in Mystery Dungeon with presents laying on the blanket)
   ✅- If you walk up to Kecleon a pop up menu appears where you can exchange your coins for some of his items. The song (25. Kecleon's Shop.mp3) plays here - (this track was added on GitHub. Please look there.)

______________________________

✅ Please allow the pokemon models on the selection screen at the beginning of the run able to be rotated just like in Pokemon Rumble Run. Please just look how Pokemon Rumble Run handles that in the Pokédex in the Reference Material from Old Project folder.

✅ Please change the Pokédex to be exactly like Pokemon Rumble Run. Please just look how Pokemon Rumble Run handles that in the Pokédex in the Reference Material from Old Project folder. But keep the relevant stats for the context of this game, like times seen, times caught, runs won for each pokemon. If you win a run with a pokemon in your party, change their Pokédex square icon background to gold. 
- At the top of the Pokédex have general stats like total runs, wins, pokemon caught, team rocket grunts defeated
- Under each pokemon name, use their type icons PNGs

______________________________

✅ Please enhance the title screen to show a POV of the camera eye level with piplup, turtwig, and Chimchar looking towards the camera in a cave and behind them is Weezing, Arbok, and meowth peeking from around 3 different corners in the cave. Piplup, turtwig, and Chimchar turn around one by one which causes Weezing, Arbok, and meowth to hide behind the objects in the cave but they reemerge again once Piplup, turtwig, and Chimchar turn around again to face the camera.

___________________________

✅ I added You Lose.mp3 to the Music Shortened Folder on GitHub. Please look there and make that play when the game over screen appears and stops all other music until you return back to the title screen. 

✅ I also added sound effects for when you Evolve (213. Evolution.mp3) and a pokemon joins your team (208. Pokemon Joins.mp3), 

✅ I also added sound effects for when you pick up coins (SE_ACT_MONEY.wav) (this track was added on GitHub. Please look there.)

________________________

✅ Please add in the Master Ball (which already exits as a 3d Model). For every other type of poke ball that spawns, the master ball has a 1/50 change of replacing it in the spawn logic. When you throw the master ball, even if you miss the pokemon, it is a guaranteed catch.  

✅ Please in the settings menu add a debug menu with password “Team Rocket” where inside this menu you can add items to your inventory and add money for testing purposes.

✅ I want to replace the items' menu sprites with better png sprites. please look in the assets/sprites folder for the new pixel art icons.

✅ Change the Full Heal to Full Restore.

✅ Make every run start with the player having 10 pokeballs. 

✅ Please remodel the stairs 3d model to be like the Minecraft cobblestone stairs model but make the stairs be heading down deeper into the dungeon and be recessed in the floor. Make the team Rocket grunts 3d model standing at the top of the stairs

____________________

✅ When you select a starter, make it so the first slot is always a grass type, the second slot is always a fire type, and the third slot is always a water type.
- Also below the Pokémon’s name on this starter selection screen only show its type(s) png and not “Fire - Basic - No. 909” for example

✅ When in a battle with a shadow pokemon, make its purple particle effects show in battle and on the catching screen, but they disappear once you add them to your team.
✅ In battle, make the pokemon slightly lunge forward when they attack. 
___________________

✅ When catching, only make the catching circle show around pokemon when you are touching the poke ball - exactly the same behavior like Pokemon Go. 
Also, when preparing to throw a curve ball, why does an orange circle appear around the poke ball? (Please remove that) 
When the poke ball releases from your throw, the shrinking circle around the pokemon stops and if you hit inside the circle there is a greater chance for you to catch it

✅ In the catching mini game, after the 3 shakes then the click when you catch a pokemon, make the click cause some yellow stars to fly off the pokeball then fade away to signify the pokemon has been caught. Also above the pokeball, make text appear saying X was caught. 

__________________

✅ When you click on your bag and you can see your pokemon team, make their models be angled 45 degrees facing towards the left. Also keep all the current pokemon info but make all 6 pokemon in your be able to fit on one row.

✅ Below the map, make the floor and dungeon name all fit on one line and be centered underneath the map (decrease the font if necessary) - for example: “B1F, Cavern”

✅ When transitioning between floors (and also after you select you starter), you already show exactly the same format as Pokemon Mystery Dungeon - Dungeon name on first line then below that is the floor number. - I want you to now make the text fade in then fade out to cleanly transition into the new floor. This should all be on a completely black screen while the text is shown on screen just like in Pokemon Mystery Dungeon.

_____________________

✅Can you please redesign the bag below the party pokemon and design it to be more thematically looking like a pixel art brown satchel bag in the inventory menu with small squares where each item takes up a slot. Design this bag to look polished and fitting pixel art.

✅If you run away from a Pokemon encounter, instead of saying “(Pokemon) slipped away” say “You fled from (Pokemon)”

✅Move the Abandon Run button in the pause menu to the top left. Then you have to shift the text saying “B3F - Scorched Desert” to the right a little more, for example. Also in that line under Paused, remove the  “- 6/6 standing text”

✅In the battle screen, where it currently says Basic, stage 1, stage 2, etc instead show the type icon pngs with a minimal space between them

After you beat a team rocket grunt, do you advise that the player is given a choice of 3 reward items? ❌
And should your team be fully healed after beating a rocket grunt? ❌

✅ Maybe add a randomly spawning Chansey station that allows you to heal once you approach it and a menu prompt appears. 

✅ Change the functionality of healing items so if your Pokemon is fainted and you use a healing item on them, it cannot bring them back from being fainted (only a revive can do that) 

_________________

✅ In the pause menu, change “Config” to Settings.

✅ As part of the Tap Move controls, also allow the user to hold in a direction and your pokemon follows your finger.





______________

✅ Please implement an endless Mode:
After you click Start Run give 2 options - Default mode on the left and on the right is endless mode below each is a description of what the mode entails. At the bottom of the default mode card shows Wins: #
Endless mode - you progress through all 11 floors before any of the other ones can repeat. You cannot encounter the same floor within 4 floors. (For example if you have forest on floor 20 you cannot see it again until at least floor 25). Giovanni appears every 5 floors
At the bottom of this card shows Deepest Floor: B1F 

Save function?
______________

✅ Are all pokemon able to be acquired in some way? how did you implement legendaries?

_____________

✅ On the title screen, Add an easy mode (place this option to the left of classic mode) with no shadow pokemon (the icon is just 1 team Rocket grunt pixel art sprite). Now that Choose a Mode screen will have horizontal scrolling - keep the same sizes of each card on that screen.

✅ Add the egg sprite from Pokemon Quest (this file already exists as the “Egg” folder within the “Extra 3D Models” folder on GitHub - look there) and there is a 1/20 chance of finding an egg instead of any other item on the floor. (Max 1 egg per floor) When you are done with a run, you can hatch the eggs and the pokemon that emerges, you can now start the run with that pokemon. Only basic pokemon can be pulled from the eggs (no stage 1, not stage 2, but you can pull legendaries) On the starter select screen, on the top right there is an egg icon that opens a menu showing all the pokemon you have unlocked. 
- On the title screen, keep the start run button in the same position and add a new button “Hatch Eggs” below the Pokédex button - (shift down items and settings) while keeping all the buttons the same size
    - On this button show an icon of the 3d egg and a number beside it to indicate how many eggs you have ready to hatch
- In the Hatch Eggs menu it shows like an inventory with 3 columns and however many rows you need. When you click on an egg, a new screen opens where you have to click the egg 3 times (egg wobbles with feedback and sound after each click and the egg gradually adds more cracks after each tap) then the egg breaks into pieces and a Pokemon emerges 
- Eggs can only hatch pokemon you have not acquired from eggs previously (eggs always give new pokemon)
- After you unlock all pokemon available in eggs (or your egg count would get you there once you hatch them), the eggs no longer appear in the dungeon. 

✅ Please change the Pokédex to be exactly like Pokemon Rumble Run. Please just look how Pokemon Rumble Run handles that in the Pokédex in the Reference Material from Old Project folder. But keep the relevant stats for the context of this game, like times seen, times caught, runs won for each pokemon. If you win a run with a pokemon in your party, change their Pokédex square icon border to be gold. 
- At the top of the Pokédex have general stats like total runs, wins, pokemon caught, team rocket grunts defeated, best endless floor reached - but make all these fit on one line
- Under each pokemon name, use their type icons PNGs
- On the top right of each eligible pokemon to be caught from eggs have a png of the 3d egg sprite be blacked out if not unlocked yet or show the sprite if the pokemon has been hatched from an egg
- Add the same filter system from Pokemon Rumble Run but make the filters applicable to this game (add egg filter, no Mega filter, etc)

✅ What happens for a split evolution line when I evolve? Are there any eligible pokemon that fit this edge case? Like eevee?

✅ Some models like Magikarp, Kabuto, and Vibrava are much larger than the others? Is this because the models scale based on x or y dimension and Magikarp, Kabuto, and Vibrava are flat pokemon? Is there a way to not make all the pokemon uniformly the same size but more in line with their real proportions while still being reasonable for this game?

✅ In Settings add a button for Free Catch Mode - there is a single screen that shows a dungeon room (randomly selected environment from the 11 possible) with 7 random pokemon walking around at different paces and movements (enable collision so the the pokemon do not clip through each other) and you have to tap them to initiate the pokemon catching mini game. You have 30 poke balls, 15 great balls, and 5 ultra balls. If you get the ice area for example, do not restrict the type of pokemon that spawn (any pokemon can spawn in any area). Make 1 legendary or mythical be guaranteed to be one of the 7 pokemon that spawn.
