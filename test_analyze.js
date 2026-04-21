/**
 * Script to test the /api/analyze endpoint locally.
 * Ensure the backend server is running on http://localhost:8080 before executing this script.
 * 
 * Usage: node test_analyze.js
 */

async function testAnalyzeEndpoint() {
  const url = 'http://localhost:8080/api/analyze';
  let hasError = false;
  
  // Customizing the payload based on the README.md specification
  const payload = {
    accounts: ['plaeto.schools'], // You can add more accounts here
    maxPosts: 2,
    includeAiOverview: false,
    generateExcel: false, 
    categories: {
      intent: ["Promotional", "Educational", "Entertainment"],
      format: ["Trend", "Tutorial", "Vlog"]
    }
  };

  console.log(`Starting analysis test on ${url}...`);
  console.log('Sending payload:\n', JSON.stringify(payload, null, 2));
  console.log('\nWaiting for response (this might take a few moments)...');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('\n✅ Success! Response received:');
    console.log(JSON.stringify(data, null, 2));
    
  } catch (error) {
    console.error('\n❌ Error testing endpoint:');
    console.error(error.message);
    hasError = true;
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

testAnalyzeEndpoint();