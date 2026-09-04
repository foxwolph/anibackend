const axios = require('axios');

async function test() {
  const base = 'http://localhost:3000';
  
  console.log('1. Testing health...');
  const health = await axios.get(`${base}/api/health`);
  console.log('   Health:', health.data);
  
  console.log('\n2. Testing search...');
  const search = await axios.get(`${base}/api/search?q=one+piece`);
  console.log(`   Found ${search.data.count} results`);
  if (search.data.results[0]) {
    console.log(`   First: ${search.data.results[0].title} (id: ${search.data.results[0].id})`);
  }
  
  console.log('\n3. Testing info...');
  const info = await axios.get(`${base}/api/info?anilistId=21`);
  console.log(`   Title: ${info.data.title}, Episodes: ${info.data.episodeCount}, Slug: ${info.data.slug}`);
  
  console.log('\n4. Testing watch (One Piece ep 1)...');
  try {
    const watch = await axios.get(`${base}/api/watch?source=anikoto&anilistId=21&ep=1&type=sub`, { timeout: 30000 });
    console.log('   Result:', JSON.stringify(watch.data, null, 2).slice(0, 500));
  } catch (e) {
    console.log('   Error:', e.response?.data || e.message);
  }
}

test().catch(console.error);
