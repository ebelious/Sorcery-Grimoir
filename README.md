# Sorcery Grimoir
This is Sorcer Grimoir, a Contested Realm Companion application for the seekers and masters of the realm. This app is a multi tool for anyone intersted in playing, understanding, and/or just interested in Sorcery Contested Realm.

## Features
- Global Saerch for cards, card key words in the FAQ and Codex for quick answers while playing
- UI for counters when playing the game with 1 player and 2 player views
- UI extras such as Dice rolling, Turn counter, win/loss tracker
- All Cards with attached FAQ and Codex keywords for easily understanding how each card is used
- Expandeable text option for smaller text that may be difficult to read 
- Direct card links to different trading markets to assess card value for easy lookup to make fair trades
- All of the amazing artists have the links to see thier awesome work
- Allows Collections to be added to keep track of all of you cards
- Settings to theme the app by color witha few different UI options, including Dice color, table color and Dice Roll animations
- Links to news, curios, rulebook, and other media
- Current news feed along with latest YouTube videos that talk about Sorcery
- This app has a lot of simple 'click to use' features that are not noted  in the app to expand images or enlarge text for easier reading that dont show an actual button.
- Decorative Death's Door Icon in UI

*This was coded using Claude AI, but has been tested for the majority of basic functionality. This is just an HTML/Javascript app hosted here on GitHub Pages. a few minor things do not work as I intended but is still being improved*


## Add the App to your phone (PWA).
There are two ways to accomplish this:<br>
    Option 1:  [Sorcery-Grimoir](https://ebelious.github.io/Sorcery-Grimoir/) > Menu > settings > Theme > Install As App <br>
    Option 2: Menu in browser > Add to Home screan, Install or Install as App <br>


## How to get API key for YouTube video feeds

1. Go to [console.developers.google.com](https://console.developers.google.com)
2. Create a project (or use an existing one)
3. Click Enable APIs → search YouTube Data API v3 → Enable
4. Go to Credentials → Create Credentials → API Key

### API Config
1. API Restrictions (limits which APIs the key can call)<br>
2. In Credentials → click your API key → API restrictions
3. Select Restrict key
4. Choose YouTube Data API v3 from the dropdown
5. Save

This means even if someone gets your key, they can only use it for YouTube — not run up charges on other Google APIs.
6. Application Restrictions (limits where the key can be used from)
7. On the same page → Application restrictions
8. Select HTTP referrers (websites)
9. Add these referrers:
```
  https://ebelious.github.io/*
  http://localhost/*
```
10. Save

In App got to `Menu > Settings > YouTubeAPI` and enter the API key into this field and `save`
- This should now populate the Youtube viedo feed<br>
**NOTE: Make sure you save this API key, because sometimes PWA saved apps can be removed from our homescreen and if you clear browser data the key will not be saved in the app**


## Preview

<details open>
<summary>Screenshots</summary>
<table>
  <tr>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145633_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145641_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145649_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145709_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145742_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145750_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145830_Brave.jpg" width="300"/></td>
    <td><img src="https://github.com/ebelious/Sorcery-Grimoir/blob/main/Screenshots/Screenshot_20260422_145839_Brave.jpg" width="300"/></td>
  </tr>
</table>
</details>

